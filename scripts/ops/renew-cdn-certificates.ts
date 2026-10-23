#!/usr/bin/env bun
/**
 * Keeps the Let's Encrypt certificates of the CDN domains current. Stateless: every run reads each
 * domain's live certificate from the CDN edge, renews only the ones with fewer than 30 days left
 * (or all with --force), issues through acme.sh 3.1.6 (ACME protocol only, a fresh account per
 * run, DNS-01 through the `dns_cdncert` hook), uploads with SetCdnDomainSSLCertificate, and checks
 * the edge now serves the new certificate. Run by .github/workflows/cdn-certificates.yml; the
 * credential is the workflow's short-lived STS role (acme.sh's own dns_ali and ali_cdn accept no
 * STS token, hence the hook and this uploader). docs/operations/cdn-certificates/ has the runbook.
 *
 *   renew-cdn-certificates.ts renew --acme-sh <acme.sh path> [--force] [--staging]
 *   renew-cdn-certificates.ts dns add|rm <_acme-challenge host> <txt value>   (called by the hook)
 *
 * --staging is a dry run against Let's Encrypt's staging CA: it issues every domain's certificate
 * (cleaning up its TXT records) and uploads nothing, since staging certificates are untrusted.
 * Issuance is rate limited (5 per week per domain set), so nothing here retries issuing: a rate
 * limit skips the domain and fails the run, and a failed upload is retried with the SAME certificate.
 */
import { X509Certificate } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  AddDomainRecordRequest,
  DeleteDomainRecordRequest,
  DescribeDomainRecordsRequest,
} from "@alicloud/alidns20150109";
import { SetCdnDomainSSLCertificateRequest } from "@alicloud/cdn20180510";

import { cdnClient, describeSdkError, dnsClient, sdkErrorCode } from "./alicloud-clients";
import {
  CDN_DOMAINS,
  DNS_ZONE,
  certName,
  challengeRecordName,
  isRateLimited,
  needsRenewal,
  parseEndDate,
  retry,
} from "./cdn-certificate-plan";

/** The notAfter of the certificate the CDN edge serves for a domain, read the way an operator
 * would: `openssl s_client` then `openssl x509 -noout -enddate`. Both steps are time-limited, and
 * anything unreadable throws: an unknown expiry must never read as "renew" or "fine". */
export async function readEdgeNotAfter(domain: string): Promise<Date> {
  const handshake = Bun.spawn(
    ["openssl", "s_client", "-servername", domain, "-connect", `${domain}:443`],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 20_000 },
  );
  const pem = await new Response(handshake.stdout).text();
  await handshake.exited;
  const parse = Bun.spawn(["openssl", "x509", "-noout", "-enddate"], {
    stdin: new Blob([pem]),
    stdout: "pipe",
    stderr: "ignore",
    timeout: 10_000,
  });
  const line = await new Response(parse.stdout).text();
  if ((await parse.exited) !== 0) throw new Error(`${domain}: could not read the edge certificate`);
  try {
    return parseEndDate(line);
  } catch (error) {
    throw new Error(`${domain}: ${error instanceof Error ? error.message : "unreadable expiry"}`);
  }
}

/** Adds the challenge TXT record; one that already exists counts as added. */
async function dnsAdd(fullDomain: string, value: string): Promise<void> {
  try {
    const client = await dnsClient();
    await client.addDomainRecord(
      new AddDomainRecordRequest({
        domainName: DNS_ZONE,
        RR: challengeRecordName(fullDomain),
        type: "TXT",
        value,
      }),
    );
  } catch (error) {
    if (sdkErrorCode(error) === "DomainRecordDuplicate") return;
    throw describeSdkError("AddDomainRecord", error);
  }
}

/** Deletes the challenge TXT records at `fullDomain`: the one holding `value`, or every one. */
async function dnsRemove(fullDomain: string, value?: string): Promise<void> {
  try {
    const rr = challengeRecordName(fullDomain);
    const client = await dnsClient();
    const found = await client.describeDomainRecords(
      new DescribeDomainRecordsRequest({
        domainName: DNS_ZONE,
        RRKeyWord: rr,
        typeKeyWord: "TXT",
        pageSize: 100,
      }),
    );
    for (const record of found.body?.domainRecords?.record ?? []) {
      const wanted = value === undefined || record.value === value;
      if (record.RR === rr && record.type === "TXT" && wanted && record.recordId)
        await client.deleteDomainRecord(
          new DeleteDomainRecordRequest({ recordId: record.recordId }),
        );
    }
  } catch (error) {
    throw describeSdkError("DNS record cleanup", error);
  }
}

/** Runs a command, echoing its output as it ends, and returns the exit code and that output. */
async function runCapture(
  command: string[],
  env: Record<string, string | undefined>,
): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(command, { env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const output = out + err;
  process.stdout.write(output);
  return { code: await child.exited, output };
}

async function waitForEdge(domain: string, expected: Date): Promise<void> {
  // The CDN applies the certificate to its edge nodes within minutes.
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const served = await readEdgeNotAfter(domain).catch(() => undefined);
    if (served && Math.abs(served.getTime() - expected.getTime()) < 1000) {
      console.log(`${domain}: edge now serves a certificate valid until ${served.toISOString()}`);
      return;
    }
    await Bun.sleep(15_000);
  }
  throw new Error(`${domain}: edge does not serve the new certificate`);
}

async function uploadCertificate(domain: string, chainPem: string, keyPem: string): Promise<void> {
  try {
    const client = await cdnClient();
    await client.setCdnDomainSSLCertificate(
      new SetCdnDomainSSLCertificateRequest({
        domainName: domain,
        certName: certName(domain, new Date()),
        certType: "upload",
        SSLProtocol: "on",
        SSLPub: chainPem,
        SSLPri: keyPem,
      }),
    );
  } catch (error) {
    throw describeSdkError("SetCdnDomainSSLCertificate", error);
  }
}

interface RenewOptions {
  acmeSh: string;
  force: boolean;
  staging: boolean;
}

async function renewDomain(domain: string, options: RenewOptions): Promise<void> {
  if (!options.force && !options.staging) {
    const edgeBefore = await readEdgeNotAfter(domain);
    if (!needsRenewal(edgeBefore, new Date(), false)) {
      console.log(`${domain}: valid until ${edgeBefore.toISOString()}, not renewing`);
      return;
    }
    console.log(`${domain}: valid until ${edgeBefore.toISOString()}, renewing`);
  }
  const challengeHost = `_acme-challenge.${domain}`;
  const work = await mkdtemp(join(tmpdir(), "cdn-cert-"));
  try {
    // Leftover TXT records from an earlier failed run would otherwise accumulate in the zone.
    await dnsRemove(challengeHost);
    const home = join(work, "acme");
    await mkdir(join(home, "dnsapi"), { recursive: true });
    await copyFile(
      new URL("./acme-dns-hook.sh", import.meta.url).pathname,
      join(home, "dnsapi", "dns_cdncert.sh"),
    );
    const fullchain = join(work, "fullchain.pem");
    const key = join(work, "key.pem");
    const env = { ...process.env, CDN_CERT_TOOL: new URL(import.meta.url).pathname };
    const server = options.staging ? "letsencrypt_test" : "letsencrypt";
    const issued = await runCapture(
      [
        "bash",
        options.acmeSh,
        "--issue",
        "--server",
        server,
        "--dns",
        "dns_cdncert",
        "--dnssleep",
        "45",
        "-d",
        domain,
        "--home",
        home,
      ],
      env,
    );
    if (isRateLimited(issued.output))
      throw new Error(
        `${domain}: Let's Encrypt rate limit reached; skipped. Do not re-run with force until the weekly limit resets`,
      );
    if (issued.code !== 0) throw new Error(`${domain}: certificate issuance failed`);
    const installed = await runCapture(
      [
        "bash",
        options.acmeSh,
        "--install-cert",
        "-d",
        domain,
        "--home",
        home,
        "--fullchain-file",
        fullchain,
        "--key-file",
        key,
      ],
      env,
    );
    if (installed.code !== 0)
      throw new Error(`${domain}: installing the issued certificate failed`);
    if (options.staging) {
      console.log(`${domain}: staging issuance succeeded; nothing uploaded`);
      return;
    }
    const chainPem = await readFile(fullchain, "utf8");
    const keyPem = await readFile(key, "utf8");
    const expected = new Date(new X509Certificate(chainPem).validTo);
    // The same certificate is re-uploaded: a failed upload must not cost another issuance.
    await retry(
      async () => {
        await uploadCertificate(domain, chainPem, keyPem);
        await waitForEdge(domain, expected);
      },
      3,
      20_000,
    );
  } finally {
    await dnsRemove(challengeHost).catch((error) =>
      console.error(`::warning::${domain}: challenge cleanup failed: ${error.message}`),
    );
    await rm(work, { recursive: true, force: true });
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "acme-sh": { type: "string" },
      force: { type: "boolean", default: false },
      staging: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const [command, ...rest] = positionals;
  if (command === "dns" && rest.length === 3 && (rest[0] === "add" || rest[0] === "rm")) {
    await (rest[0] === "add" ? dnsAdd : dnsRemove)(rest[1] as string, rest[2] as string);
    return 0;
  }
  if (command === "renew" && values["acme-sh"]) {
    let failures = 0;
    for (const domain of CDN_DOMAINS) {
      try {
        await renewDomain(domain, {
          acmeSh: values["acme-sh"],
          force: values.force === true,
          staging: values.staging === true,
        });
      } catch (error) {
        failures += 1;
        console.error(
          `::error::${error instanceof Error ? error.message : `${domain}: renewal failed`}`,
        );
      }
    }
    return failures === 0 ? 0 : 1;
  }
  console.error(
    "usage: renew-cdn-certificates.ts renew --acme-sh PATH [--force] [--staging] | dns add|rm HOST VALUE",
  );
  return 2;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));

import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

import { parseOidcToken, requestOidcToken } from "./alicloud-clients";
import {
  CDN_DOMAINS,
  certName,
  challengeRecordName,
  isRateLimited,
  needsRenewal,
  parseEndDate,
  retry,
} from "./cdn-certificate-plan";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-23T00:00:00Z");

describe("renewal decision", () => {
  test("renews under 30 days, skips at or above, always renews on force", () => {
    expect(needsRenewal(new Date(now.getTime() + 29 * DAY), now, false)).toBe(true);
    expect(needsRenewal(new Date(now.getTime() + 30 * DAY), now, false)).toBe(false);
    expect(needsRenewal(new Date(now.getTime() + 80 * DAY), now, false)).toBe(false);
    expect(needsRenewal(new Date(now.getTime() + 80 * DAY), now, true)).toBe(true);
    expect(needsRenewal(new Date(now.getTime() - DAY), now, false)).toBe(true);
    // An unreadable expiry fails closed instead of reading as "renew".
    expect(() => needsRenewal(new Date("invalid"), now, false)).toThrow("valid date");
  });

  test("names the uploaded certificate by domain and epoch milliseconds", () => {
    expect(certName("docs.coforge.cn", now)).toBe(`cert-docs.coforge.cn-${now.getTime()}`);
  });

  test("maps a challenge host to its record name inside the zone", () => {
    expect(challengeRecordName("_acme-challenge.docs.coforge.cn")).toBe("_acme-challenge.docs");
    expect(() => challengeRecordName("_acme-challenge.example.com")).toThrow("zone");
    expect(() => challengeRecordName(".coforge.cn")).toThrow("zone");
  });
});

describe("edge expiry and issuance guards", () => {
  test("parses openssl's enddate and throws on anything else", () => {
    expect(parseEndDate("notAfter=Jan 21 00:00:00 2027 GMT\n").toISOString()).toBe(
      "2027-01-21T00:00:00.000Z",
    );
    expect(() => parseEndDate("")).toThrow("expiry");
    expect(() => parseEndDate("notAfter=garbage")).toThrow("valid date");
  });

  test("recognises a Let's Encrypt rate limit in acme.sh output", () => {
    expect(isRateLimited("urn:ietf:params:acme:error:rateLimited: too many")).toBe(true);
    expect(isRateLimited("too many certificates (5) already issued")).toBe(true);
    expect(isRateLimited("Verification finished, beginning signing.")).toBe(false);
  });

  test("retry re-runs the same work a bounded number of times", async () => {
    let calls = 0;
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    expect(
      await retry(
        async () => {
          calls += 1;
          if (calls < 3) throw new Error("boom");
          return "ok";
        },
        3,
        10,
        sleep,
      ),
    ).toBe("ok");
    expect(waits).toEqual([10, 20]);
    let attempts = 0;
    await expect(
      retry(
        async () => {
          attempts += 1;
          throw new Error("always");
        },
        3,
        1,
        sleep,
      ),
    ).rejects.toThrow("always");
    expect(attempts).toBe(3);
  });
});

describe("GitHub OIDC token request", () => {
  const env = {
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example/?x=1",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "bearer-secret",
  };

  test("fails on an empty or null token, and outside Actions asks for nothing", async () => {
    expect(() => parseOidcToken({ value: null })).toThrow("no OIDC token");
    expect(() => parseOidcToken({ value: "" })).toThrow("no OIDC token");
    expect(() => parseOidcToken(null)).toThrow("no OIDC token");
    expect(parseOidcToken({ value: "jwt" })).toBe("jwt");
    expect(await requestOidcToken({})).toBeUndefined();
  });

  test("asks for the STS audience, retries, and never reports the bearer", async () => {
    const urls: string[] = [];
    let calls = 0;
    const fetchImpl = (async (url: URL) => {
      urls.push(String(url));
      calls += 1;
      if (calls === 1) return new Response("no", { status: 500 });
      return Response.json({ value: "fresh-jwt" });
    }) as unknown as typeof fetch;
    expect(await requestOidcToken(env, fetchImpl, 3)).toBe("fresh-jwt");
    expect(urls[0]).toContain("audience=sts.aliyuncs.com");
    const failing = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const error = await requestOidcToken(env, failing, 1).catch((e: Error) => e);
    expect((error as Error).message).toContain("HTTP 500");
    expect((error as Error).message).not.toContain("bearer-secret");
  });
});

describe("domain list single source", () => {
  test("is the JSON file, and the runbook table lists exactly those domains", async () => {
    const file = await Bun.file(new URL("./cdn-certificate-domains.json", import.meta.url)).json();
    expect(CDN_DOMAINS).toEqual(file);
    expect(new Set(CDN_DOMAINS).size).toBe(CDN_DOMAINS.length);
    const directory = new URL("../../docs/operations/cdn-certificates/", import.meta.url);
    const names = (await readdir(directory)).filter((name) => name.endsWith(".md"));
    const text = (await Promise.all(names.map((n) => Bun.file(new URL(n, directory)).text()))).join(
      "\n",
    );
    for (const domain of CDN_DOMAINS) expect(text).toContain(`\`${domain}\``);
    const domains = await Bun.file(new URL("domains.md", directory)).text();
    const listed = [...domains.matchAll(/^\| `([a-z.-]+\.coforge\.cn)` \|/gm)].map((m) => m[1]);
    expect(listed).toEqual([...CDN_DOMAINS]);
  });
});

describe("workflow and tool", () => {
  test("the workflow pins acme.sh to its tag and digest and masks the OIDC token", async () => {
    const workflow = await Bun.file(
      new URL("../../.github/workflows/cdn-certificates.yml", import.meta.url),
    ).text();
    expect(workflow).toContain("tags/3.1.6.tar.gz");
    expect(workflow).toMatch(/ACME_SH_SHA256: [0-9a-f]{64}/);
    expect(workflow).toContain("environment: certificates");
    expect(workflow).toContain("ALIBABA_CLOUD_OIDC_TOKEN_FILE");
    expect(workflow).toContain("staging:");
    // The tool, not a one-time step, requests the short-lived OIDC token and masks it.
    const clients = await Bun.file(new URL("./alicloud-clients.ts", import.meta.url)).text();
    expect(clients).toContain("::add-mask::");
  });

  test("the docs workflow masks the OIDC token and fails when it is missing", async () => {
    const workflow = await Bun.file(
      new URL("../../.github/workflows/docs-production.yml", import.meta.url),
    ).text();
    expect(workflow).toContain("::add-mask::");
    expect(workflow).toContain("curl -sSf --retry 3");
    expect(workflow).toMatch(/\[ -n "\$token" \] && \[ "\$token" != null \]|"\$token" = null/);
  });

  test("the tool names the CA, never prints key material, and holds no AccessKey", async () => {
    const tool = await Bun.file(new URL("./renew-cdn-certificates.ts", import.meta.url)).text();
    expect(tool).toContain('"letsencrypt"');
    expect(tool).not.toMatch(/LTAI[0-9A-Za-z]{16,}/);
    expect(tool).not.toMatch(/console\.(log|error)\([^)]*(SSLPri|key\b)/);
  });

  test("the aliyun-oss-cdn runbook points at the certificate runbook", async () => {
    const dir = new URL("../../docs/operations/aliyun-oss-cdn/", import.meta.url);
    const names = (await readdir(dir)).filter((name) => name.endsWith(".md"));
    const text = (await Promise.all(names.map((n) => Bun.file(new URL(n, dir)).text()))).join("\n");
    expect(text).toContain("cdn-certificates/");
    expect(text).not.toContain("不自动续期");
  });
});

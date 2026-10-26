#!/usr/bin/env bun
/**
 * Creates the long-lived self-signed code-signing identity the darwin Computer executables are
 * signed with (darwin-signing.ts), once, on the repository owner's Mac:
 *
 *   bun scripts/release/generate-darwin-signing-identity.ts --key-out ~/secure/coforge-signing.key
 *
 * The private key goes to `--key-out`, which must lie outside this repository and must not exist;
 * the public certificate goes to the committed path darwin-signing.ts pins its designated
 * requirement from, and an existing certificate is never overwritten: replacing the identity costs
 * every user one more macOS privacy (TCC) grant. The key is never printed; the next steps load it
 * into the GitHub environments from a file on stdin, never from argv.
 */
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  DARWIN_SIGNING_CERTIFICATE_PATH,
  DARWIN_SIGNING_KEY_ENV,
  certificateSha1,
  pinnedDesignatedRequirement,
} from "./darwin-signing";
import { generateSigningIdentity } from "./darwin-signing-identity";

const REPO_ROOT = resolve(import.meta.dir, "../..");

export const SIGNING_COMMON_NAME = "CoForge Computer Code Signing";
/** Twenty years: a new certificate means a new designated requirement, which costs every user
 * one more privacy grant, so the identity outlives any plausible release schedule. */
export const SIGNING_VALIDITY_DAYS = 7305;

export type GenerateCliOptions = {
  /** Where the certificate is committed; the repository's pinned path by default. */
  certificatePath?: string;
  log?: (line: string) => void;
  logError?: (line: string) => void;
};

/** `--key-out` must be a new file outside the repository, so the private key cannot be committed
 * by accident. The parent directory is resolved through symlinks before it is compared. */
async function resolveKeyOut(raw: string): Promise<string> {
  const absolute = resolve(raw);
  let parent: string;
  try {
    parent = await realpath(dirname(absolute));
  } catch {
    throw new Error(`--key-out directory does not exist: ${dirname(absolute)}`);
  }
  const keyOut = join(parent, basename(absolute));
  const fromRepo = relative(await realpath(REPO_ROOT), keyOut);
  if (fromRepo === "" || (!fromRepo.startsWith("..") && !isAbsolute(fromRepo))) {
    throw new Error("--key-out must be outside the repository");
  }
  if (await Bun.file(keyOut).exists()) {
    throw new Error(`--key-out already exists, refusing to overwrite it: ${keyOut}`);
  }
  return keyOut;
}

export async function runCli(argv: string[], options: GenerateCliOptions = {}): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const logError = options.logError ?? ((line: string) => console.error(line));
  const certificatePath = options.certificatePath ?? DARWIN_SIGNING_CERTIFICATE_PATH;
  try {
    const { values } = parseArgs({
      args: argv,
      options: { "key-out": { type: "string" } },
      strict: true,
    });
    if (values["key-out"] === undefined) throw new Error("--key-out <path> is required");
    const keyOut = await resolveKeyOut(values["key-out"]);
    if (await Bun.file(certificatePath).exists()) {
      throw new Error(
        `a certificate is already committed at ${certificatePath}; replacing it changes the ` +
          "designated requirement and costs every user a privacy grant, so it is never overwritten",
      );
    }

    const { keyPem, certificatePem } = await generateSigningIdentity({
      commonName: SIGNING_COMMON_NAME,
      days: SIGNING_VALIDITY_DAYS,
    });
    // The certificate's directory may not exist yet. Made before the key is written, so a failure
    // here leaves nothing behind; `wx` fails if either file appeared since the checks above.
    await mkdir(dirname(certificatePath), { recursive: true, mode: 0o755 });
    await writeFile(keyOut, keyPem, { flag: "wx", mode: 0o600 });
    try {
      await writeFile(certificatePath, certificatePem, { flag: "wx" });
    } catch (error) {
      // A key without its certificate would be orphaned: the identity is only usable as a pair.
      await rm(keyOut, { force: true });
      throw error;
    }

    log(`Private key written to ${keyOut} (mode 0600).`);
    log(`Certificate written to ${certificatePath}.`);
    log(`SHA-1 fingerprint: ${certificateSha1(certificatePem)}`);
    log(`Pinned designated requirement: ${pinnedDesignatedRequirement(certificatePem)}`);
    log("");
    log("Next steps:");
    log("  1. Set the key in both GitHub environments, from stdin and never from argv:");
    for (const environment of ["staging", "production"]) {
      log(
        `       gh secret set ${DARWIN_SIGNING_KEY_ENV} --repo lrm-lab/coforge --env ${environment} < ${keyOut}`,
      );
    }
    log(
      "  2. Keep an offline backup of the key. Losing it, or replacing it, gives every user a new",
    );
    log("     designated requirement and so one more macOS privacy (TCC) grant.");
    log(`  3. Commit ${certificatePath}.`);
    return 0;
  } catch (error) {
    logError(
      `generate-darwin-signing-identity failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}

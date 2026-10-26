import { afterEach, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DarwinSigningIdentity } from "../darwin-signing";
import { generateSigningIdentity } from "../darwin-signing-identity";

/** Registers the removal of every directory the returned function creates after each test; call
 * it at the top level of a test file. */
export function useTempDirs(): (prefix: string) => Promise<string> {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });
  return async (prefix) => {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    directories.push(directory);
    return directory;
  };
}

/** What `openssl x509 -noout <args>` prints for a certificate, independent of the code under test. */
export function opensslX509(certificatePath: string, ...args: string[]): string {
  const result = Bun.spawnSync(["openssl", "x509", "-in", certificatePath, "-noout", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

/** A throwaway signing identity made at test time: its certificate is written to `directory`, its
 * key stays in memory, and nothing of it is ever committed. */
export async function createThrowawayIdentity(
  directory: string,
  name: string,
): Promise<DarwinSigningIdentity & { certificatePem: string }> {
  const { keyPem, certificatePem } = await generateSigningIdentity({
    commonName: `CoForge Test Signing ${name}`,
    days: 1,
  });
  const certificatePath = join(directory, `${name}.pem`);
  await writeFile(certificatePath, certificatePem);
  return { keyPem, certificatePath, certificatePem };
}

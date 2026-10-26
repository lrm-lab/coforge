import { expect, test } from "bun:test";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { certificateSha1, pinnedDesignatedRequirement } from "./darwin-signing";
import { opensslX509, useTempDirs } from "./fixtures/darwin-signing-identity";
import { SIGNING_VALIDITY_DAYS, runCli } from "./generate-darwin-signing-identity";

const tempDir = useTempDirs();

function runGenerator(argv: string[], certificatePath: string) {
  const out: string[] = [];
  const err: string[] = [];
  const exit = runCli(argv, {
    certificatePath,
    log: (line) => out.push(line),
    logError: (line) => err.push(line),
  });
  return exit.then((exitCode) => ({ exitCode, out: out.join("\n"), err: err.join("\n") }));
}

test("it writes a 0600 key and a 20-year code-signing certificate, and prints the next steps without the key", async () => {
  const directory = await tempDir("coforge-generate-signing-");
  // The key path is reported with its symlinks resolved (`/var` is `/private/var` on macOS).
  const keyOut = join(await realpath(directory), "signing.key");
  const certificatePath = join(directory, "coforge-computer-signing.pem");

  const { exitCode, out, err } = await runGenerator(["--key-out", keyOut], certificatePath);

  expect(err).toBe("");
  expect(exitCode).toBe(0);
  const key = await Bun.file(keyOut).text();
  expect(key).toContain("PRIVATE KEY");
  expect((await stat(keyOut)).mode & 0o777).toBe(0o600);

  const certificatePem = await Bun.file(certificatePath).text();
  expect(certificatePem).not.toContain("PRIVATE KEY");
  const text = opensslX509(certificatePath, "-text");
  expect(text).toContain("CN=CoForge Computer Code Signing");
  expect(text).toContain("CA:FALSE");
  expect(text).toContain("Digital Signature");
  expect(text).toContain("Code Signing");
  const [notBefore, notAfter] = opensslX509(certificatePath, "-dates")
    .trim()
    .split("\n")
    .map((line) => Date.parse(line.split("=")[1]!));
  expect(Math.round((notAfter! - notBefore!) / 86_400_000)).toBe(SIGNING_VALIDITY_DAYS);

  expect(out).toContain(certificateSha1(certificatePem));
  expect(out).toContain(pinnedDesignatedRequirement(certificatePem));
  for (const environment of ["staging", "production"]) {
    expect(out).toContain(
      `gh secret set COFORGE_DARWIN_SIGNING_KEY --repo lrm-lab/coforge --env ${environment} < ${keyOut}`,
    );
  }
  expect(out).toContain("offline backup");
  for (const line of key.split("\n").filter((line) => line.length > 20)) {
    expect(out).not.toContain(line);
  }
});

test("it refuses a key path inside the repository, an existing key, an existing certificate, or no key path", async () => {
  const directory = await tempDir("coforge-generate-signing-");
  const certificatePath = join(directory, "coforge-computer-signing.pem");
  const existingKey = join(directory, "existing.key");
  await writeFile(existingKey, "keep me");

  const inside = await runGenerator(
    ["--key-out", join(import.meta.dir, "signing.key")],
    certificatePath,
  );
  expect(inside.exitCode).toBe(1);
  expect(inside.err).toContain("outside the repository");

  const existing = await runGenerator(["--key-out", existingKey], certificatePath);
  expect(existing.exitCode).toBe(1);
  expect(existing.err).toContain("already exists");
  expect(await Bun.file(existingKey).text()).toBe("keep me");

  const missing = await runGenerator([], certificatePath);
  expect(missing.exitCode).toBe(1);
  expect(missing.err).toContain("--key-out");

  await writeFile(certificatePath, "committed certificate");
  const keyOut = join(directory, "new.key");
  const certificateExists = await runGenerator(["--key-out", keyOut], certificatePath);
  expect(certificateExists.exitCode).toBe(1);
  expect(certificateExists.err).toContain("already committed");
  expect(await Bun.file(certificatePath).text()).toBe("committed certificate");
  expect(await Bun.file(keyOut).exists()).toBe(false);
  expect(await Bun.file(join(import.meta.dir, "signing.key")).exists()).toBe(false);
});

test("it creates the certificate's directory when it does not exist yet", async () => {
  const directory = await tempDir("coforge-generate-signing-");
  const keyOut = join(directory, "signing.key");
  const certificatePath = join(directory, "missing", "darwin-signing", "signing.pem");

  const { exitCode, err } = await runGenerator(["--key-out", keyOut], certificatePath);

  expect(err).toBe("");
  expect(exitCode).toBe(0);
  expect((await stat(dirname(certificatePath))).mode & 0o777).toBe(0o755);
  expect(await Bun.file(certificatePath).text()).toContain("BEGIN CERTIFICATE");
  expect(await Bun.file(keyOut).text()).toContain("PRIVATE KEY");
});

test("a certificate that cannot be written does not leave the key behind", async () => {
  const directory = await tempDir("coforge-generate-signing-");
  const keyOut = join(directory, "signing.key");
  // A directory squats on the certificate's path: not an existing file, but not writable either.
  const certificatePath = join(directory, "signing.pem");
  await mkdir(certificatePath);

  const { exitCode, err } = await runGenerator(["--key-out", keyOut], certificatePath);

  expect(exitCode).toBe(1);
  expect(err).toContain("generate-darwin-signing-identity failed");
  expect(await Bun.file(keyOut).exists()).toBe(false);
});

/**
 * Signs one darwin executable with the Computer's long-lived self-signed code-signing identity and
 * verifies the result. Nothing else: which targets are signed is compile-targets.ts's decision,
 * when a publish requires it is publish.ts's.
 *
 * Why: macOS keys a privacy (TCC) grant to the executable's designated requirement. Bun's ad-hoc
 * signature has `cdhash H"..."` as its requirement, which differs for every build, so every upgrade
 * lost the user's grants. Signed with one certificate under one identifier, every version has the
 * same requirement:
 *
 *   designated => identifier "cn.coforge.computer" and certificate leaf = H"<sha1 of the cert>"
 *
 * The certificate is public and committed (`darwin-signing/coforge-computer-signing.pem`); the
 * requirement is derived from it here, so a signature from any other certificate fails
 * verification. Only the PEM private key is secret. It comes in the `COFORGE_DARWIN_SIGNING_KEY`
 * environment variable, is written to a 0600 file in a fresh private directory, and is removed with
 * that directory and the temporary keychain it is imported into. There is no hardened runtime and
 * there are no entitlements: those wait for a paid Developer ID certificate.
 *
 * The signer is Apple's `codesign`, so signing runs on a macOS host.
 */
import { X509Certificate, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isDarwinTarget } from "./compile-targets";

export const DARWIN_SIGNING_IDENTIFIER = "cn.coforge.computer";
export const DARWIN_SIGNING_KEY_ENV = "COFORGE_DARWIN_SIGNING_KEY";
export const DARWIN_SIGNING_CERTIFICATE_PATH = join(
  import.meta.dir,
  "darwin-signing/coforge-computer-signing.pem",
);

const CODESIGN = "/usr/bin/codesign";
const SECURITY = "/usr/bin/security";
/** The variable that hands the ephemeral PKCS#12 password to `openssl` without putting it on its
 * command line. */
const EPHEMERAL_PASSWORD_ENV = "COFORGE_DARWIN_SIGNING_EPHEMERAL";

export type DarwinSigningIdentity = {
  /** The PEM private key matching the certificate. */
  keyPem: string;
  /** The PEM public certificate, whose SHA-1 the designated requirement pins. */
  certificatePath: string;
};

/** Lowercase hex SHA-1 of the certificate's DER encoding - what `codesign` prints as the leaf. */
export function certificateSha1(pem: string): string {
  if (pem.split("-----BEGIN CERTIFICATE-----").length !== 2) {
    throw new Error("expected exactly one certificate in the PEM");
  }
  return new X509Certificate(pem).fingerprint.replaceAll(":", "").toLowerCase();
}

/** The `designated =>` line `codesign -d -r-` prints for an executable signed by `pem`'s identity. */
export function pinnedDesignatedRequirement(pem: string): string {
  return `designated => identifier "${DARWIN_SIGNING_IDENTIFIER}" and certificate leaf = H"${certificateSha1(pem)}"`;
}

/** Whether `keyPem` is the private key of `certificatePem`'s certificate. Neither value appears in
 * the errors, which say only which of the two is unusable. */
function assertKeyMatchesCertificate(keyPem: string, certificatePem: string): void {
  const spki = (key: { export(options: { type: "spki"; format: "der" }): Buffer }) =>
    key.export({ type: "spki", format: "der" });
  let fromKey: Buffer;
  let fromCertificate: Buffer;
  try {
    fromKey = spki(createPublicKey(createPrivateKey(keyPem)));
  } catch {
    throw new Error(`${DARWIN_SIGNING_KEY_ENV} is not a PEM private key`);
  }
  try {
    fromCertificate = spki(new X509Certificate(certificatePem).publicKey);
  } catch {
    throw new Error("the signing certificate is not a PEM certificate");
  }
  if (!fromKey.equals(fromCertificate)) {
    throw new Error(`${DARWIN_SIGNING_KEY_ENV} is not the private key of the signing certificate`);
  }
}

/** What a publish needs before it compiles anything: a macOS host, the private key in the
 * environment that belongs to the committed certificate. Each argument defaults to the real one;
 * tests pass their own. When it reads the real environment it removes the key from it afterwards:
 * the key lives on in the returned identity, and no later child process inherits it. */
export async function requireDarwinSigningIdentity(
  options: {
    platform?: NodeJS.Platform;
    env?: Record<string, string | undefined>;
    certificatePath?: string;
  } = {},
): Promise<DarwinSigningIdentity> {
  const platform = options.platform ?? process.platform;
  const keyPem = (options.env ?? Bun.env)[DARWIN_SIGNING_KEY_ENV];
  if (!options.env) {
    delete process.env[DARWIN_SIGNING_KEY_ENV];
    delete Bun.env[DARWIN_SIGNING_KEY_ENV];
  }
  const certificatePath = options.certificatePath ?? DARWIN_SIGNING_CERTIFICATE_PATH;
  if (platform !== "darwin") {
    throw new Error(
      `a publish signs the darwin executables with Apple's codesign and needs a macOS host, not ${platform}`,
    );
  }
  if (!keyPem) {
    throw new Error(
      `a publish signs the darwin executables: set ${DARWIN_SIGNING_KEY_ENV} to the PEM private key`,
    );
  }
  if (!(await Bun.file(certificatePath).exists())) {
    throw new Error(
      `the signing certificate is missing: ${certificatePath} (generate-darwin-signing-identity.ts creates it)`,
    );
  }
  assertKeyMatchesCertificate(keyPem, await Bun.file(certificatePath).text());
  return { keyPem, certificatePath };
}

type Output = { stdout: string; stderr: string };

/** Runs one tool to completion with an argument array. The signing key never reaches a child's
 * environment, and a failure reports the tool's name and stderr only, never its arguments. */
export async function run(
  command: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<Output> {
  const { [DARWIN_SIGNING_KEY_ENV]: _key, ...env } = Bun.env;
  const child = Bun.spawn([command, ...args], {
    env: { ...env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.split("/").pop()} failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return { stdout, stderr };
}

/** Fails unless `executable` verifies strictly and its designated requirement is exactly the one
 * pinned to `certificatePem`'s certificate under the Computer's identifier. */
export async function verifyDarwinExecutable(
  executable: string,
  certificatePem: string,
): Promise<void> {
  await run(CODESIGN, ["--verify", "--strict", executable]);
  const { stdout, stderr } = await run(CODESIGN, ["-d", "-r-", executable]);
  const expected = pinnedDesignatedRequirement(certificatePem);
  const designated = `${stdout}\n${stderr}`
    .split("\n")
    .find((line) => line.startsWith("designated =>"));
  if (designated !== expected) {
    throw new Error(
      `${executable} has the wrong designated requirement: expected ${expected}, got ${designated ?? "none"}`,
    );
  }
}

/** Signs `executable` in place and verifies it. The identity is imported into a keychain that
 * exists only for this call, in a directory only this user can read; both are removed afterwards,
 * whether or not signing succeeded. */
export async function signDarwinExecutable(
  executable: string,
  identity: DarwinSigningIdentity,
): Promise<void> {
  const certificatePem = await Bun.file(identity.certificatePath).text();
  const sha1 = certificateSha1(certificatePem);

  const directory = await mkdtemp(join(tmpdir(), "coforge-darwin-signing-"));
  const keychain = join(directory, "signing.keychain-db");
  try {
    const keyPath = join(directory, "signing-key.pem");
    await writeFile(keyPath, identity.keyPem, { mode: 0o600 });

    // macOS cannot import a key and certificate as one identity from two PEM files, and its
    // PKCS#12 reader rejects an empty password and OpenSSL 3's default AES/PBKDF2 encoding, so
    // they travel through a PKCS#12 file with the 3DES encoding, protected by a password made up
    // for this call. That password only guards a file and a keychain deleted moments later, so it
    // is acceptable on `security`'s command line; `openssl` takes it from its environment.
    const password = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    const bundle = join(directory, "identity.p12");
    await run(
      "openssl",
      [
        "pkcs12",
        "-export",
        "-certpbe",
        "PBE-SHA1-3DES",
        "-keypbe",
        "PBE-SHA1-3DES",
        "-macalg",
        "sha1",
        "-inkey",
        keyPath,
        "-in",
        identity.certificatePath,
        "-out",
        bundle,
        "-passout",
        `env:${EPHEMERAL_PASSWORD_ENV}`,
      ],
      { [EPHEMERAL_PASSWORD_ENV]: password },
    );
    await run(SECURITY, ["create-keychain", "-p", password, keychain]);
    await run(SECURITY, ["unlock-keychain", "-p", password, keychain]);
    await run(SECURITY, ["import", bundle, "-k", keychain, "-P", password, "-T", CODESIGN]);
    await run(SECURITY, [
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:",
      "-s",
      "-k",
      password,
      keychain,
    ]);

    // `--keychain` alone finds the identity on a developer Mac but not on a GitHub macOS runner
    // ("no identity found"): codesign there resolves it only through the user search list.
    const searchList = await userKeychains();
    await run(SECURITY, ["list-keychains", "-d", "user", "-s", keychain, ...searchList]);
    try {
      await run(CODESIGN, [
        "--force",
        "--sign",
        sha1,
        "--keychain",
        keychain,
        "--identifier",
        DARWIN_SIGNING_IDENTIFIER,
        executable,
      ]);
    } finally {
      await run(SECURITY, ["list-keychains", "-d", "user", "-s", ...searchList]);
    }
    await verifyDarwinExecutable(executable, certificatePem);
  } finally {
    await run(SECURITY, ["delete-keychain", keychain]).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

/** The user keychain search list, as `security list-keychains` prints it: one quoted path a line. */
async function userKeychains(): Promise<string[]> {
  const { stdout } = await run(SECURITY, ["list-keychains", "-d", "user"]);
  return stdout
    .split("\n")
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

/** The `sign` callback a publish of `targets` compiles with, or undefined when none is a darwin
 * target. Resolving the identity first fails a publish that cannot sign before it compiles. */
export async function darwinSignerFor(
  targets: readonly string[],
  resolveIdentity: () => Promise<DarwinSigningIdentity> = requireDarwinSigningIdentity,
): Promise<((executable: string) => Promise<void>) | undefined> {
  if (!targets.some(isDarwinTarget)) return undefined;
  const identity = await resolveIdentity();
  return (executable) => signDarwinExecutable(executable, identity);
}

import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DARWIN_SIGNING_IDENTIFIER,
  DARWIN_SIGNING_KEY_ENV,
  certificateSha1,
  pinnedDesignatedRequirement,
  requireDarwinSigningIdentity,
  signDarwinExecutable,
  verifyDarwinExecutable,
} from "./darwin-signing";
import {
  createThrowawayIdentity,
  opensslX509,
  useTempDirs,
} from "./fixtures/darwin-signing-identity";

const tempDir = useTempDirs();

// What the whole file shares: two throwaway identities and one small executable to copy and sign.
let shared: string;
let identity: Awaited<ReturnType<typeof createThrowawayIdentity>>;
let other: Awaited<ReturnType<typeof createThrowawayIdentity>>;
let baseProgram: string;

/** A small Bun-compiled executable, built outside bun:test like compile-targets.test.ts does. */
async function compileProgram(directory: string, name: string, message: string): Promise<string> {
  const source = join(directory, `${name}.ts`);
  const output = join(directory, name);
  await writeFile(source, `console.log(${JSON.stringify(message)});\n`);
  const build = Bun.spawnSync(
    [process.execPath, "build", "--compile", source, "--outfile", output],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(build.exitCode, build.stderr.toString()).toBe(0);
  return output;
}

async function copyProgram(directory: string, name: string): Promise<string> {
  const copy = join(directory, name);
  await copyFile(baseProgram, copy);
  return copy;
}

beforeAll(async () => {
  shared = await mkdtemp(join(tmpdir(), "coforge-signing-shared-"));
  identity = await createThrowawayIdentity(shared, "identity");
  other = await createThrowawayIdentity(shared, "other");
  if (process.platform === "darwin") baseProgram = await compileProgram(shared, "base", "hello");
});

afterAll(async () => {
  await rm(shared, { recursive: true, force: true });
});

function designatedRequirement(executable: string): string {
  const result = Bun.spawnSync(["/usr/bin/codesign", "-d", "-r-", executable], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  return `${result.stdout}\n${result.stderr}`
    .split("\n")
    .find((line) => line.startsWith("designated =>"))!;
}

test("the pinned requirement names the Computer's identifier and the certificate's SHA-1", () => {
  const fingerprint = opensslX509(identity.certificatePath, "-fingerprint", "-sha1")
    .split("=")[1]!
    .trim()
    .replaceAll(":", "")
    .toLowerCase();
  expect(certificateSha1(identity.certificatePem)).toBe(fingerprint);
  expect(pinnedDesignatedRequirement(identity.certificatePem)).toBe(
    `designated => identifier "cn.coforge.computer" and certificate leaf = H"${fingerprint}"`,
  );
  expect(DARWIN_SIGNING_IDENTIFIER).toBe("cn.coforge.computer");
  // Not exactly one certificate: nothing to pin.
  expect(() => certificateSha1("")).toThrow(/exactly one certificate/);
  expect(() => certificateSha1(identity.certificatePem + identity.certificatePem)).toThrow(
    /exactly one certificate/,
  );
});

test("a publish needs a macOS host, the key in the environment and the committed certificate", async () => {
  const env = { [DARWIN_SIGNING_KEY_ENV]: identity.keyPem };
  const certificatePath = identity.certificatePath;

  await expect(
    requireDarwinSigningIdentity({ platform: "linux", env, certificatePath }),
  ).rejects.toThrow(/needs a macOS host, not linux/);
  await expect(
    requireDarwinSigningIdentity({ platform: "darwin", env: {}, certificatePath }),
  ).rejects.toThrow(DARWIN_SIGNING_KEY_ENV);
  await expect(
    requireDarwinSigningIdentity({
      platform: "darwin",
      env: { [DARWIN_SIGNING_KEY_ENV]: "" },
      certificatePath,
    }),
  ).rejects.toThrow(DARWIN_SIGNING_KEY_ENV);
  await expect(
    requireDarwinSigningIdentity({
      platform: "darwin",
      env,
      certificatePath: join(shared, "missing.pem"),
    }),
  ).rejects.toThrow(/signing certificate is missing/);
  expect(await requireDarwinSigningIdentity({ platform: "darwin", env, certificatePath })).toEqual({
    keyPem: identity.keyPem,
    certificatePath,
  });
});

test("a key that is not the certificate's, or not a PEM at all, is refused without being reported", async () => {
  const certificatePath = identity.certificatePath;
  const refusals = [
    [other.keyPem, /is not the private key of the signing certificate/],
    [
      "-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----\n",
      /not a PEM private key/,
    ],
    ["just some text", /not a PEM private key/],
  ] as const;
  for (const [keyPem, message] of refusals) {
    const failure = await requireDarwinSigningIdentity({
      platform: "darwin",
      env: { [DARWIN_SIGNING_KEY_ENV]: keyPem },
      certificatePath,
    }).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(failure).toMatch(message);
    for (const line of keyPem.split("\n").filter((line) => line.length > 12)) {
      expect(failure).not.toContain(line);
    }
  }
  const malformedCertificate = join(shared, "malformed.pem");
  await writeFile(malformedCertificate, "not a certificate");
  await expect(
    requireDarwinSigningIdentity({
      platform: "darwin",
      env: { [DARWIN_SIGNING_KEY_ENV]: identity.keyPem },
      certificatePath: malformedCertificate,
    }),
  ).rejects.toThrow(/not a PEM certificate/);
});

test("reading the real environment removes the key from it, an injected one is left alone", async () => {
  const original = process.env[DARWIN_SIGNING_KEY_ENV];
  const injected = { [DARWIN_SIGNING_KEY_ENV]: identity.keyPem };
  try {
    process.env[DARWIN_SIGNING_KEY_ENV] = identity.keyPem;
    const resolved = await requireDarwinSigningIdentity({
      platform: "darwin",
      certificatePath: identity.certificatePath,
    });
    expect(resolved.keyPem).toBe(identity.keyPem);
    expect(process.env[DARWIN_SIGNING_KEY_ENV]).toBeUndefined();
    expect(Bun.env[DARWIN_SIGNING_KEY_ENV]).toBeUndefined();

    process.env[DARWIN_SIGNING_KEY_ENV] = "kept";
    await requireDarwinSigningIdentity({
      platform: "darwin",
      env: injected,
      certificatePath: identity.certificatePath,
    });
    expect(process.env[DARWIN_SIGNING_KEY_ENV]).toBe("kept");
    expect(injected[DARWIN_SIGNING_KEY_ENV]).toBe(identity.keyPem);
  } finally {
    if (original === undefined) delete process.env[DARWIN_SIGNING_KEY_ENV];
    else process.env[DARWIN_SIGNING_KEY_ENV] = original;
  }
});

test("a signed executable still runs, verifies strictly, and has the same requirement in every version", async () => {
  if (process.platform !== "darwin") return;
  const directory = await tempDir("coforge-signing-sign-");
  const expected = pinnedDesignatedRequirement(identity.certificatePem);
  // The scratch directory and keychain `signDarwinExecutable` makes live under TMPDIR; none may
  // outlive the call, since the key is written there.
  const scratchRoot = await tempDir("coforge-signing-scratch-");
  const originalTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = scratchRoot;

  // Two different builds: the copy of the shared one and a second, distinct program.
  const builds = [
    { executable: await copyProgram(directory, "first"), output: "hello\n" },
    {
      executable: await compileProgram(directory, "second", "hello again"),
      output: "hello again\n",
    },
  ];
  const versions: string[] = [];
  try {
    for (const { executable, output } of builds) {
      await signDarwinExecutable(executable, identity);
      const verify = Bun.spawnSync(["/usr/bin/codesign", "--verify", "--strict", executable], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(verify.stderr.toString()).toBe("");
      expect(verify.exitCode).toBe(0);
      versions.push(designatedRequirement(executable));
      const run = Bun.spawnSync([executable], { stdout: "pipe", stderr: "pipe" });
      expect(run.exitCode).toBe(0);
      expect(run.stdout.toString()).toBe(output);
    }
  } finally {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
  }
  // Two different builds, one requirement: the property TCC grants rely on.
  expect(versions).toEqual([expected, expected]);
  expect(await readdir(scratchRoot)).toEqual([]);
}, 60_000);

test("verification refuses an executable signed by another certificate or changed after signing", async () => {
  if (process.platform !== "darwin") return;
  const executable = await copyProgram(await tempDir("coforge-signing-refuse-"), "program");

  await signDarwinExecutable(executable, other);
  // Valid, but not by the certificate the repository pins.
  await expect(verifyDarwinExecutable(executable, identity.certificatePem)).rejects.toThrow(
    /wrong designated requirement/,
  );

  await signDarwinExecutable(executable, identity);
  await verifyDarwinExecutable(executable, identity.certificatePem);
  const bytes = new Uint8Array(await Bun.file(executable).arrayBuffer());
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  await Bun.write(executable, bytes);
  await expect(verifyDarwinExecutable(executable, identity.certificatePem)).rejects.toThrow(
    /codesign failed/,
  );
}, 60_000);

test("a key that does not belong to the certificate is refused, and the key is never reported", async () => {
  if (process.platform !== "darwin") return;
  const executable = await copyProgram(await tempDir("coforge-signing-mismatch-"), "program");

  const failure = await signDarwinExecutable(executable, {
    keyPem: other.keyPem,
    certificatePath: identity.certificatePath,
  }).then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  expect(failure).toStartWith("openssl failed");
  for (const line of other.keyPem.split("\n").filter((line) => line.length > 20)) {
    expect(failure).not.toContain(line);
  }
}, 60_000);

import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isReleaseTarget, resolveBunCompileTarget } from "./compile-targets";
import { DARWIN_SIGNING_KEY_ENV, verifyDarwinExecutable } from "./darwin-signing";
import { createThrowawayIdentity } from "./fixtures/darwin-signing-identity";

test("a darwin build given a signer returns the bytes of its signed executable", async () => {
  if (process.platform !== "darwin") return;
  const target = `darwin-${process.arch}`;
  if (!isReleaseTarget(target)) throw new Error(`unsupported test host: ${target}`);
  const directory = await mkdtemp(join(tmpdir(), "coforge-signed-executable-"));
  try {
    const identity = await createThrowawayIdentity(directory, "compile");
    const outputDirectory = join(directory, "artifacts");
    // The key reaches the build through its environment, like a publish's; the build prints the
    // digest of the bytes it returned, which a checksum computed later would cover.
    const build = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/compile-signed-computer.ts"),
        target,
        "9.8.7-rc.6",
        "https://releases-staging.coforge.cn",
        outputDirectory,
        identity.certificatePath,
      ],
      {
        env: { ...Bun.env, [DARWIN_SIGNING_KEY_ENV]: identity.keyPem },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(build.stderr.toString()).toBe("");
    expect(build.exitCode).toBe(0);
    const executable = join(outputDirectory, `${target}-coforge-computer`);
    await verifyDarwinExecutable(executable, identity.certificatePem);
    const digest = new Bun.CryptoHasher("sha256")
      .update(new Uint8Array(await Bun.file(executable).arrayBuffer()))
      .digest("hex");
    expect(build.stdout.toString().trim()).toBe(digest);
    const version = Bun.spawnSync([executable, "--cli-version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(version.exitCode).toBe(0);
    expect(version.stdout.toString()).toBe("9.8.7-rc.6\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("every release target used by updater.ts, install.sh and install.ps1 maps to a bun-<os>-<arch> compile target", () => {
  const targets = [
    "linux-x64",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
    "windows-x64",
    "windows-arm64",
  ];
  for (const target of targets) {
    expect(isReleaseTarget(target)).toBe(true);
    // Compared as a plain string: the return type is a union of the six literals, which a
    // `bun-${string}` template type is not assignable to.
    expect(String(resolveBunCompileTarget(target))).toBe(`bun-${target}`);
  }
});

test("an unsupported target throws instead of silently resolving to nothing", () => {
  for (const invalid of ["linux-x86", "windows", "", "linux-x64 ", "LINUX-X64"]) {
    expect(isReleaseTarget(invalid)).toBe(false);
    expect(() => resolveBunCompileTarget(invalid)).toThrow(/unsupported release target/);
  }
});

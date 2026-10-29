import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeStartFailedError } from "@lrm/coforge-anvil";
import { DSH_ACP_VERSION } from "@lrm/coforge-anvil/dsh";
import { readVersionOutput } from "#src/code-agent/version-probe";

const lastWord = (output: string) => output.trim().split(/\s+/).pop() || undefined;

/** A stand-in runtime CLI whose `--version` does whatever this script says. */
async function runtimeScript(body: string): Promise<{ command: string; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "coforge-version-probe-"));
  const command = join(directory, "runtime-cli");
  await writeFile(command, `#!/bin/sh\n${body}\n`);
  await chmod(command, 0o755);
  return { command, directory };
}

test("a CLI that exits non-zero is a start failure, with the redacted stderr first line", async () => {
  const { command, directory } = await runtimeScript(
    `echo 'No version is set for shim: node' >&2\nexit 1`,
  );
  try {
    const error = await readVersionOutput([command], lastWord).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(RuntimeStartFailedError);
    expect((error as RuntimeStartFailedError).code).toBe("runtime_start_failed");
    // The one line a person needs, not a version judgement.
    expect((error as RuntimeStartFailedError).diagnostic).toBe("No version is set for shim: node");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a CLI that cannot be spawned at all is a start failure too", async () => {
  const error = await readVersionOutput(["/nonexistent/runtime-cli"], lastWord).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(RuntimeStartFailedError);
});

test("a CLI that prints its version reads it", async () => {
  const { command, directory } = await runtimeScript(`echo ${DSH_ACP_VERSION}`);
  try {
    expect(await readVersionOutput([command], lastWord)).toBe(DSH_ACP_VERSION);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a CLI that runs but prints no version reads as an unread version, not a failure", async () => {
  const { command, directory } = await runtimeScript(`echo 'no version here'`);
  try {
    expect(await readVersionOutput([command], () => undefined)).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a token-looking stderr line never leaves the probe", async () => {
  const { command, directory } = await runtimeScript(
    `echo 'auth failed with sk-live-abcdefgh12345678' >&2\nexit 2`,
  );
  try {
    const error = (await readVersionOutput([command], lastWord).then(
      () => undefined,
      (reason: unknown) => reason,
    )) as RuntimeStartFailedError;
    expect(error.diagnostic).toBe("auth failed with [redacted]");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

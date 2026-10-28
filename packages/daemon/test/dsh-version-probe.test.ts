import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeStartFailedError } from "@lrm/coforge-anvil";
import { DSH_ACP_VERSION } from "@lrm/coforge-anvil/dsh";
import { readDshVersionOutput } from "#src/code-agent/dsh/version-probe";

/** A stand-in DSH whose `--version` does whatever this script says. */
async function dshScript(body: string): Promise<{ command: string; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "coforge-dsh-version-"));
  const command = join(directory, "dsh");
  await writeFile(command, `#!/bin/sh\n${body}\n`);
  await chmod(command, 0o755);
  return { command, directory };
}

test("a DSH that exits non-zero is a start failure, with the redacted stderr first line", async () => {
  const { command, directory } = await dshScript(
    `echo 'No version is set for shim: node' >&2\nexit 1`,
  );
  try {
    const error = await readDshVersionOutput([command]).then(
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

test("a DSH that cannot be spawned at all is a start failure too", async () => {
  const error = await readDshVersionOutput(["/nonexistent/dsh"]).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(RuntimeStartFailedError);
});

test("a DSH that prints its pinned version reads it", async () => {
  const { command, directory } = await dshScript(`echo ${DSH_ACP_VERSION}`);
  try {
    expect(await readDshVersionOutput([command])).toBe(DSH_ACP_VERSION);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a token-looking stderr line never leaves the probe", async () => {
  const { command, directory } = await dshScript(
    `echo 'auth failed with sk-live-abcdefgh12345678' >&2\nexit 2`,
  );
  try {
    const error = (await readDshVersionOutput([command]).then(
      () => undefined,
      (reason: unknown) => reason,
    )) as RuntimeStartFailedError;
    expect(error.diagnostic).toBe("auth failed with [redacted]");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

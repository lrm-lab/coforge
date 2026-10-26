import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareDshLaunchFiles } from "#src/code-agent/dsh/launch-files";

const render = (instructions: string, path: string) => ({
  plugin: "static plugin",
  patch: JSON.stringify({ path, instructions }),
});

test("DSH host keeps its plugin and patch in one private temporary directory", async () => {
  const files = await prepareDshLaunchFiles("{{x}}\n中文", render);
  try {
    const directory = dirname(files.patchPath);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(directory))
      expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
    const patch = await Bun.file(files.patchPath).json();
    expect(patch.instructions).toBe("{{x}}\n中文");
    expect(dirname(patch.path)).toBe(directory);
    expect(await Bun.file(patch.path).text()).toBe("static plugin");
  } finally {
    await files.cleanup();
  }
  expect(await Bun.file(files.patchPath).exists()).toBe(false);
  await expect(stat(dirname(files.patchPath))).rejects.toMatchObject({ code: "ENOENT" });
  await files.cleanup();
});

test("DSH host removes its temporary directory if launch-content preparation fails", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "dsh-launch-failure-"));
  try {
    await expect(
      prepareDshLaunchFiles(
        "instructions",
        () => {
          throw new Error("invalid instructions");
        },
        temporaryRoot,
      ),
    ).rejects.toThrow("invalid instructions");
    expect(await readdir(temporaryRoot)).toEqual([]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { procJobCgroupDirectoryIdentity } from "#src/platform/proc-job-systemd-memory";
import { readProcJobMemoryScopeUsage } from "#src/platform/proc-job-systemd-scope";

test("reads current cgroup bytes only from the original populated scope on the original boot", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-scope-usage-"));
  const systemdUnit = "coforge-usage.scope";
  const group = "/" + systemdUnit;
  const folder = join(root, systemdUnit);
  const bootId = "00000000-0000-0000-0000-000000000001";
  try {
    await mkdir(folder);
    const events = join(folder, "cgroup.events");
    const current = join(folder, "memory.current");
    await Bun.write(events, "populated 1\nfrozen 0\n");
    const target = {
      systemdUnit,
      memoryScope: {
        bootId,
        invocationId: "abcdef0123456789abcdef0123456789",
        group,
        directory: await procJobCgroupDirectoryIdentity(folder),
        rootDirectory: await procJobCgroupDirectoryIdentity(root),
      },
    };
    const sources = { root, readBootId: async () => bootId };
    const read = () => readProcJobMemoryScopeUsage(target, "linux", sources);

    expect(await read()).toBeUndefined();
    for (const bytes of [0, 8 * 1024 * 1024]) {
      await Bun.write(current, bytes + "\n");
      expect(await read()).toBe(bytes);
    }
    for (const invalid of ["-1", "8k", "9007199254740992", "10\n20"]) {
      await Bun.write(current, invalid + "\n");
      expect(await read()).toBeUndefined();
    }
    await Bun.write(current, "42\n");
    expect(await readProcJobMemoryScopeUsage(target, "darwin", sources)).toBeUndefined();
    expect(
      await readProcJobMemoryScopeUsage(target, "linux", {
        ...sources,
        readBootId: async () => "00000000-0000-0000-0000-000000000002",
      }),
    ).toBeUndefined();
    await Bun.write(events, "populated 0\n");
    expect(await read()).toBeUndefined();
    await rename(folder, join(root, "original.scope"));
    await mkdir(folder);
    await Bun.write(events, "populated 1\n");
    await Bun.write(current, "64\n");
    expect(await read()).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

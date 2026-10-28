import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverExternalCodeAgents } from "#src/code-agent/runtime-probe";
import type { ExternalCodeAgentProbe } from "#src/code-agent/runtime-executable";
import {
  fileStatCacheKey,
  readInventoryCache,
  writeInventoryCache,
} from "#src/code-agent/runtime-inventory-cache";

describe("Code Agent probe cache", () => {
  test("skips the version spawn when the cached probe key still matches the executable", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-state-"));
    const binDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-bin-"));
    const codexPath = join(binDirectory, "codex");
    await Bun.write(codexPath, "#!/bin/sh\necho codex\n");
    try {
      let spawnCalls = 0;
      const probe: ExternalCodeAgentProbe = {
        which: (name) => (name === "codex" ? codexPath : undefined),
        spawn: () => {
          spawnCalls++;
          return { stdout: new Blob(["codex-cli 0.151.0"]).stream(), exited: Promise.resolve(0) };
        },
      };

      const first = await discoverExternalCodeAgents(
        probe,
        { PATH: "" },
        undefined,
        undefined,
        stateDirectory,
      );
      expect(first).toEqual([{ provider: "codex", version: "0.151.0", displayName: "Codex" }]);
      expect(spawnCalls).toBe(1);

      const second = await discoverExternalCodeAgents(
        probe,
        { PATH: "" },
        undefined,
        undefined,
        stateDirectory,
      );
      expect(second).toEqual(first);
      expect(spawnCalls).toBe(1);

      // Touching the executable changes its mtime, which invalidates the cache key.
      const future = new Date(Date.now() + 60_000);
      await utimes(codexPath, future, future);

      const third = await discoverExternalCodeAgents(
        probe,
        { PATH: "" },
        undefined,
        undefined,
        stateDirectory,
      );
      expect(third).toEqual(first);
      expect(spawnCalls).toBe(2);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
      await rm(binDirectory, { recursive: true, force: true });
    }
  });

  test("re-validates a cached Kiro runtime and drops it when below the compatibility baseline", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-state-"));
    const binDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-bin-"));
    const kiroPath = join(binDirectory, "kiro-cli");
    await Bun.write(kiroPath, "#!/bin/sh\necho kiro-cli\n");
    try {
      // Simulate a cache entry an older daemon build wrote before the version gate existed.
      const key = await fileStatCacheKey([kiroPath]);
      await writeInventoryCache(stateDirectory, {
        kiro: { key: key!, runtime: { provider: "kiro", version: "2.16.0", displayName: "Kiro" } },
      });
      let spawnCalls = 0;
      const probe: ExternalCodeAgentProbe = {
        which: (name) => (name === "kiro-cli" ? kiroPath : undefined),
        spawn: () => {
          spawnCalls++;
          return { stdout: new Blob(["kiro-cli 2.16.0"]).stream(), exited: Promise.resolve(0) };
        },
      };

      const runtimes = await discoverExternalCodeAgents(
        probe,
        { PATH: "" },
        undefined,
        undefined,
        stateDirectory,
      );

      expect(runtimes).toEqual([]);
      // The executable itself is unchanged, so a stale cache hit is rejected without re-spawning;
      // a live re-probe would only reproduce the same gate outcome.
      expect(spawnCalls).toBe(0);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
      await rm(binDirectory, { recursive: true, force: true });
    }
  });

  test("re-validates a cached OpenCode runtime and drops it when below 2.0.30", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-state-"));
    const binDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-bin-"));
    const opencodePath = join(binDirectory, "opencode");
    await Bun.write(opencodePath, "#!/bin/sh\necho opencode\n");
    try {
      const key = await fileStatCacheKey([opencodePath]);
      await writeInventoryCache(stateDirectory, {
        opencode: {
          key: key!,
          runtime: { provider: "opencode", version: "2.0.29", displayName: "OpenCode" },
        },
      });
      let spawnCalls = 0;
      const probe: ExternalCodeAgentProbe = {
        which: (name) => (name === "opencode" ? opencodePath : undefined),
        spawn: () => {
          spawnCalls++;
          return { stdout: new Blob(["opencode v2.0.29"]).stream(), exited: Promise.resolve(0) };
        },
      };

      const runtimes = await discoverExternalCodeAgents(
        probe,
        { PATH: "" },
        undefined,
        undefined,
        stateDirectory,
      );

      expect(runtimes).toEqual([]);
      expect(spawnCalls).toBe(0);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
      await rm(binDirectory, { recursive: true, force: true });
    }
  });

  test("re-validates a cached Devin runtime and drops it when below its minimum", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-state-"));
    const binDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-bin-"));
    const devinPath = join(binDirectory, "devin");
    await Bun.write(devinPath, "#!/bin/sh\necho devin\n");
    try {
      const key = await fileStatCacheKey([devinPath]);
      await writeInventoryCache(stateDirectory, {
        devin: {
          key: key!,
          runtime: { provider: "devin", version: "3000.11.100", displayName: "Devin" },
        },
      });
      let spawnCalls = 0;
      const probe: ExternalCodeAgentProbe = {
        which: (name) => (name === "devin" ? devinPath : undefined),
        spawn: () => {
          spawnCalls++;
          return {
            stdout: new Blob(["devin 3000.11.100 (053434014dbd)"]).stream(),
            exited: Promise.resolve(0),
          };
        },
      };

      const runtimes = await discoverExternalCodeAgents(
        probe,
        { PATH: "" },
        undefined,
        undefined,
        stateDirectory,
      );

      expect(runtimes).toEqual([]);
      expect(spawnCalls).toBe(0);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
      await rm(binDirectory, { recursive: true, force: true });
    }
  });

  test("does not restore a cached OpenCode runtime below 2.0.30 when the live probe rejects it", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-state-"));
    const binDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-bin-"));
    const opencodePath = join(binDirectory, "opencode");
    await Bun.write(opencodePath, "#!/bin/sh\necho opencode\n");
    try {
      await writeInventoryCache(stateDirectory, {
        opencode: {
          key: "stale-before-replace",
          runtime: { provider: "opencode", version: "2.0.7", displayName: "OpenCode" },
        },
      });
      let spawnCalls = 0;
      const probe: ExternalCodeAgentProbe = {
        which: (name) => (name === "opencode" ? opencodePath : undefined),
        spawn: () => {
          spawnCalls++;
          return { stdout: new Blob(["opencode v2.0.20"]).stream(), exited: Promise.resolve(0) };
        },
      };

      await expect(
        discoverExternalCodeAgents(probe, { PATH: "" }, undefined, undefined, stateDirectory),
      ).resolves.toEqual([]);
      expect(spawnCalls).toBe(1);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
      await rm(binDirectory, { recursive: true, force: true });
    }
  });

  test("does not restore a supported cached OpenCode runtime when the live binary is below 2.0.30", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-state-"));
    const binDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-bin-"));
    const opencodePath = join(binDirectory, "opencode");
    await Bun.write(opencodePath, "#!/bin/sh\necho opencode\n");
    try {
      await writeInventoryCache(stateDirectory, {
        opencode: {
          key: "stale-supported",
          runtime: { provider: "opencode", version: "2.0.40", displayName: "OpenCode" },
        },
      });
      const probe: ExternalCodeAgentProbe = {
        which: (name) => (name === "opencode" ? opencodePath : undefined),
        spawn: () => ({
          stdout: new Blob(["opencode v2.0.29"]).stream(),
          exited: Promise.resolve(0),
        }),
      };

      await expect(
        discoverExternalCodeAgents(probe, { PATH: "" }, undefined, undefined, stateDirectory),
      ).resolves.toEqual([]);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
      await rm(binDirectory, { recursive: true, force: true });
    }
  });

  test("a rejected OpenCode probe drops a supported cache so a later miss cannot restore it", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-state-"));
    const binDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-bin-"));
    const opencodePath = join(binDirectory, "opencode");
    await Bun.write(opencodePath, "#!/bin/sh\necho opencode\n");
    try {
      await writeInventoryCache(stateDirectory, {
        opencode: {
          key: "stale-supported",
          runtime: { provider: "opencode", version: "2.0.40", displayName: "OpenCode" },
        },
      });
      let reject = true;
      const probe: ExternalCodeAgentProbe = {
        which: (name) => (name === "opencode" ? opencodePath : undefined),
        spawn: () =>
          reject
            ? { stdout: new Blob(["opencode v2.0.29"]).stream(), exited: Promise.resolve(0) }
            : { stdout: new Blob(["broken\n"]).stream(), exited: Promise.resolve(1) },
      };

      await expect(
        discoverExternalCodeAgents(probe, { PATH: "" }, undefined, undefined, stateDirectory),
      ).resolves.toEqual([]);
      expect((await readInventoryCache(stateDirectory)).opencode).toBeUndefined();

      reject = false;
      await expect(
        discoverExternalCodeAgents(probe, { PATH: "" }, undefined, undefined, stateDirectory),
      ).resolves.toEqual([]);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
      await rm(binDirectory, { recursive: true, force: true });
    }
  });

  test("a discovery that read the cache before a rejection cannot restore the dropped runtime", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-state-"));
    const binDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-bin-"));
    const opencodePath = join(binDirectory, "opencode");
    const kiroPath = join(binDirectory, "kiro-cli");
    await Bun.write(opencodePath, "#!/bin/sh\necho opencode\n");
    await Bun.write(kiroPath, "#!/bin/sh\necho kiro-cli\n");
    try {
      await writeInventoryCache(stateDirectory, {
        opencode: {
          key: "seed-supported",
          runtime: { provider: "opencode", version: "2.0.40", displayName: "OpenCode" },
        },
      });
      let releaseKiro!: () => void;
      const kiroGate = new Promise<number>((resolve) => {
        releaseKiro = () => resolve(0);
      });
      let kiroProbing!: () => void;
      const kiroStarted = new Promise<void>((resolve) => {
        kiroProbing = resolve;
      });
      const probe: ExternalCodeAgentProbe = {
        which: (name) =>
          name === "opencode" ? opencodePath : name === "kiro-cli" ? kiroPath : undefined,
        spawn: (command) => {
          if (command === kiroPath) {
            kiroProbing();
            return { stdout: new Blob(["kiro-cli 99.0.0"]).stream(), exited: kiroGate };
          }
          return { stdout: new Blob(["opencode v2.0.29"]).stream(), exited: Promise.resolve(0) };
        },
      };

      // This discovery reads the cache, which still holds the supported OpenCode runtime, then
      // holds while its own probe is outstanding.
      const kiroDiscovery = discoverExternalCodeAgents(
        probe,
        { PATH: "" },
        undefined,
        "kiro",
        stateDirectory,
      );
      await kiroStarted;
      // Meanwhile an OpenCode probe reads and refuses the version, dropping the cached runtime.
      await discoverExternalCodeAgents(probe, { PATH: "" }, undefined, "opencode", stateDirectory);
      releaseKiro();
      await kiroDiscovery;

      // The first discovery persists after the drop; it must not write the runtime back.
      expect((await readInventoryCache(stateDirectory)).opencode?.runtime).toBeUndefined();
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
      await rm(binDirectory, { recursive: true, force: true });
    }
  });

  test("keeps a supported cached OpenCode runtime when the live version probe exits non-zero", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-state-"));
    const binDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-bin-"));
    const opencodePath = join(binDirectory, "opencode");
    await Bun.write(opencodePath, "#!/bin/sh\necho opencode\n");
    try {
      await writeInventoryCache(stateDirectory, {
        opencode: {
          key: "stale-supported",
          runtime: { provider: "opencode", version: "2.0.40", displayName: "OpenCode" },
        },
      });
      const probe: ExternalCodeAgentProbe = {
        which: (name) => (name === "opencode" ? opencodePath : undefined),
        spawn: () => ({
          stdout: new Blob(["broken\n"]).stream(),
          exited: Promise.resolve(1),
        }),
      };

      await expect(
        discoverExternalCodeAgents(probe, { PATH: "" }, undefined, undefined, stateDirectory),
      ).resolves.toEqual([{ provider: "opencode", version: "2.0.40", displayName: "OpenCode" }]);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
      await rm(binDirectory, { recursive: true, force: true });
    }
  });

  test("does not restore a cached OpenCode runtime below 2.0.30 when the version probe throws", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-state-"));
    const binDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-bin-"));
    const opencodePath = join(binDirectory, "opencode");
    await Bun.write(opencodePath, "#!/bin/sh\necho opencode\n");
    try {
      await writeInventoryCache(stateDirectory, {
        opencode: {
          key: "stale-before-throw",
          runtime: { provider: "opencode", version: "2.0.29", displayName: "OpenCode" },
        },
      });
      const probe: ExternalCodeAgentProbe = {
        which: (name) => (name === "opencode" ? opencodePath : undefined),
        spawn: () => {
          throw new Error("version probe failed");
        },
      };

      await expect(
        discoverExternalCodeAgents(probe, { PATH: "" }, undefined, undefined, stateDirectory),
      ).resolves.toEqual([]);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
      await rm(binDirectory, { recursive: true, force: true });
    }
  });

  test("does not restore a supported cached Devin runtime when the live binary is below the floor", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-state-"));
    const binDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-bin-"));
    const devinPath = join(binDirectory, "devin");
    await Bun.write(devinPath, "#!/bin/sh\necho devin\n");
    try {
      await writeInventoryCache(stateDirectory, {
        devin: {
          key: "stale-supported",
          runtime: { provider: "devin", version: "3000.11.228", displayName: "Devin" },
        },
      });
      const probe: ExternalCodeAgentProbe = {
        which: (name) => (name === "devin" ? devinPath : undefined),
        spawn: () => ({
          stdout: new Blob(["devin 3000.11.100 (053434014dbd)"]).stream(),
          exited: Promise.resolve(0),
        }),
      };

      await expect(
        discoverExternalCodeAgents(probe, { PATH: "" }, undefined, undefined, stateDirectory),
      ).resolves.toEqual([]);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
      await rm(binDirectory, { recursive: true, force: true });
    }
  });

  test("without a cache directory, every discovery spawns again", async () => {
    let spawnCalls = 0;
    const probe: ExternalCodeAgentProbe = {
      which: (name) => (name === "codex" ? "/bin/codex" : undefined),
      spawn: () => {
        spawnCalls++;
        return { stdout: new Blob(["codex-cli 0.151.0"]).stream(), exited: Promise.resolve(0) };
      },
    };
    await discoverExternalCodeAgents(probe);
    await discoverExternalCodeAgents(probe);
    expect(spawnCalls).toBe(2);
  });
});

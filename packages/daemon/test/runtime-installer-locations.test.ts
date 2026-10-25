import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCodeAgentInventory } from "#src/code-agent/runtime-inventory";
import { discoverExternalCodeAgents } from "#src/code-agent/runtime-probe";
import type { ExternalCodeAgentProbe } from "#src/code-agent/runtime-executable";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";

const OPENCODE_FIXTURE = anvilRuntimeFixtures.opencode;

describe("provider installer locations", () => {
  test("finds CLIs in provider-specific locations when PATH misses them", async () => {
    const home = await mkdtemp(join(tmpdir(), "coforge-provider-installs-"));
    const installed = {
      codex: join(home, "Applications", "Codex.app", "Contents", "Resources", "codex"),
      opencode: join(home, ".opencode", "bin", "opencode"),
      grok: join(home, ".grok", "bin", "grok"),
    };
    for (const executable of Object.values(installed)) {
      await mkdir(join(executable, ".."), { recursive: true });
      await Bun.write(executable, "fixture");
    }
    const probed: string[] = [];
    const probe: ExternalCodeAgentProbe = {
      which: () => undefined,
      exists: (candidate) => Object.values(installed).includes(candidate),
      spawn: (executable) => {
        probed.push(executable);
        return {
          stdout: new Blob([
            executable === installed.codex
              ? "codex-cli 0.151.0\n"
              : executable === installed.grok
                ? "grok 1.0.62 (fixture)\n"
                : "2.1.0\n",
          ]).stream(),
          exited: Promise.resolve(0),
        };
      },
    };

    try {
      await expect(
        discoverExternalCodeAgents(probe, { HOME: home, PATH: "/usr/bin:/bin" }, "darwin"),
      ).resolves.toEqual([
        { provider: "codex", version: "0.151.0", displayName: "Codex" },
        { provider: "opencode", version: "2.1.0", displayName: "OpenCode" },
        { provider: "grok", version: "1.0.62", displayName: "Grok Build" },
      ]);
      expect(probed.toSorted()).toEqual(Object.values(installed).toSorted());
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("uses an installer-location executable for OpenCode catalog discovery", async () => {
    const home = await mkdtemp(join(tmpdir(), "coforge-opencode-install-"));
    const executable = join(home, ".opencode", "bin", "opencode");
    await mkdir(join(executable, ".."), { recursive: true });
    await Bun.write(executable, "fixture");
    try {
      const inventory = await discoverCodeAgentInventory({
        probe: {
          which: () => undefined,
          exists: (candidate) => candidate === executable,
          spawn: () => ({
            stdout: new Blob(["2.1.0\n"]).stream(),
            exited: Promise.resolve(0),
          }),
        },
        commands: { opencode: [process.execPath, OPENCODE_FIXTURE, "models"] },
        environment: { HOME: home, PATH: process.env.PATH },
        platform: "darwin",
        piModels: async () => [],
      });

      expect(
        inventory.catalogs.find((catalog) => catalog.provider === "opencode")?.models.length,
      ).toBeGreaterThan(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

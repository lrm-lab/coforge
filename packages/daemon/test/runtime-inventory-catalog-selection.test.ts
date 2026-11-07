import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCodeAgentCatalogs } from "#src/code-agent/runtime-inventory";
import type { ExternalCodeAgentProbe } from "#src/code-agent/runtime-executable";

/** A command override that records its label and exits, standing in for a provider CLI. */
async function markerCommand(directory: string, label: string) {
  const script = join(directory, `${label}.ts`);
  const log = join(directory, "spawned.log");
  await Bun.write(
    script,
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, ${JSON.stringify(label)} + "\\n");\n`,
  );
  return [process.execPath, script] as const;
}

async function spawnedLabels(directory: string): Promise<string[]> {
  const log = join(directory, "spawned.log");
  const text = await Bun.file(log)
    .text()
    .catch(() => "");
  return text.split("\n").filter((line) => line.length > 0);
}

describe("Code Agent catalog discovery selection", () => {
  test("a catalog refresh for one provider spawns only that provider's CLI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coforge-catalog-selection-"));
    try {
      const commands = {
        codex: await markerCommand(directory, "codex"),
        kiro: await markerCommand(directory, "kiro"),
        cursor: await markerCommand(directory, "cursor"),
      };
      const probe: ExternalCodeAgentProbe = {
        which: (name) => (name in commands ? `/fake/${name}` : undefined),
        spawn: () => ({
          stdout: new Blob([]).stream(),
          exited: Promise.resolve(0),
        }),
      };
      let piDiscoveries = 0;
      await discoverCodeAgentCatalogs(
        [
          { provider: "codex" as const, version: "1", displayName: "Codex" },
          { provider: "kiro" as const, version: "1", displayName: "Kiro" },
          { provider: "cursor" as const, version: "1", displayName: "Cursor" },
        ],
        {
          cwd: directory,
          environment: { HOME: directory, PATH: "" },
          commands,
          probe,
          piModels: async () => {
            piDiscoveries += 1;
            return [];
          },
          provider: "codex",
          force: true,
        },
      );
      expect(await spawnedLabels(directory)).toEqual(["codex"]);
      expect(piDiscoveries).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a forced refresh of another provider does not reject for an uninstalled DSH", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coforge-catalog-dsh-"));
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const probe: ExternalCodeAgentProbe = {
        which: (name) => (name === "codex" ? "/fake/codex" : undefined),
        spawn: () => ({
          stdout: new Blob([]).stream(),
          exited: Promise.resolve(0),
        }),
      };
      await discoverCodeAgentCatalogs(
        [
          { provider: "codex" as const, version: "1", displayName: "Codex" },
          { provider: "dsh" as const, version: "0.2.1", displayName: "DeepSeek Harness" },
        ],
        {
          cwd: directory,
          environment: { HOME: directory, PATH: "" },
          probe,
          piModels: async () => [],
          provider: "codex",
          force: true,
        },
      );
      // A dropped rejection surfaces on a later turn of the event loop.
      await Bun.sleep(50);
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

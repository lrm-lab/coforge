import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMAND_CODE_MIN_CLI_VERSION } from "@lrm/coforge-anvil/command-code";
import { discoverExternalCodeAgents } from "#src/code-agent/runtime-probe";
import type { ExternalCodeAgentProbe } from "#src/code-agent/runtime-executable";
import { fileStatCacheKey, writeInventoryCache } from "#src/code-agent/runtime-inventory-cache";
import { captureDaemonLogs } from "./log-capture";

function commandCodeProbe(versionOutput: string): ExternalCodeAgentProbe {
  return {
    which: (name) => (name === "cmd" ? "/bin/cmd" : undefined),
    spawn: () => ({
      stdout: new Blob([versionOutput]).stream(),
      exited: Promise.resolve(0),
    }),
  };
}

describe("Command Code minimum CLI version gate", () => {
  test("does not report Command Code and logs a warning when the CLI is below 1.87.2", async () => {
    const { records } = await captureDaemonLogs(async () => {
      await expect(discoverExternalCodeAgents(commandCodeProbe("1.87.1\n"))).resolves.toEqual([]);
    });
    const warning = records.find(
      (record) => record.properties.event === "code_agent_runtime:version_unsupported",
    );
    expect(warning?.properties).toMatchObject({
      provider: "command-code",
      executable_name: "cmd",
      version: "1.87.1",
      minimum_version: COMMAND_CODE_MIN_CLI_VERSION,
      outcome: "unavailable",
    });
  });

  test.each([
    ["1.87.2\n", "1.87.2"],
    ["1.87.3\n", "1.87.3"],
  ])(
    "reports Command Code when the CLI meets the baseline (%s)",
    async (versionOutput, version) => {
      await expect(discoverExternalCodeAgents(commandCodeProbe(versionOutput))).resolves.toEqual([
        { provider: "command-code", version, displayName: "Command Code" },
      ]);
    },
  );

  test("reports Command Code when the version output cannot be confidently parsed", async () => {
    await expect(discoverExternalCodeAgents(commandCodeProbe("unknown\n"))).resolves.toEqual([
      { provider: "command-code", version: "unknown", displayName: "Command Code" },
    ]);
  });

  test("re-validates a cached Command Code runtime and drops it when below 1.87.2", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-command-code-cache-"));
    const binDirectory = await mkdtemp(join(tmpdir(), "coforge-command-code-bin-"));
    const cmdPath = join(binDirectory, "cmd");
    await Bun.write(cmdPath, "#!/bin/sh\necho 1.87.1\n");
    try {
      const key = await fileStatCacheKey([cmdPath]);
      await writeInventoryCache(stateDirectory, {
        "command-code": {
          key: key!,
          runtime: { provider: "command-code", version: "1.87.1", displayName: "Command Code" },
        },
      });
      let spawnCalls = 0;
      const probe: ExternalCodeAgentProbe = {
        which: (name) => (name === "cmd" ? cmdPath : undefined),
        spawn: () => {
          spawnCalls++;
          return { stdout: new Blob(["1.87.1\n"]).stream(), exited: Promise.resolve(0) };
        },
      };
      await expect(
        discoverExternalCodeAgents(probe, { PATH: "" }, undefined, undefined, stateDirectory),
      ).resolves.toEqual([]);
      expect(spawnCalls).toBe(0);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
      await rm(binDirectory, { recursive: true, force: true });
    }
  });
});

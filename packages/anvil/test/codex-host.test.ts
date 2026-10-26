import { expect, test } from "bun:test";
import { CodexProvider, type CodexRuntimeHost } from "@lrm/coforge-anvil/codex";

test("Codex evaluates each required host environment at its public operation and preserves spawn failures", async () => {
  const calls: string[] = [];
  const marker = new Error("host spawn failed");
  const host: CodexRuntimeHost = {
    clientInfo: { name: "fixture", title: "Fixture", version: "fixture" },
    usageClientInfo: { name: "fixture-usage", title: "Fixture Usage", version: "fixture" },
    maskAccountLabel: (label) => label,
    buildSessionEnvironment(options) {
      expect(this).toBe(host);
      expect(options.agentWorkspaceDirectory).toBe("/session");
      calls.push("session");
      return { OPERATION: "session" };
    },
    buildUsageEnvironment(environment) {
      expect(this).toBe(host);
      expect(environment).toBeUndefined();
      calls.push("usage");
      return { OPERATION: "usage" };
    },
    processTreeSpawner: {
      spawn(command, cwd, environment) {
        expect(command).toEqual(["fixture-codex", "app-server"]);
        expect(cwd).toBe("/" + environment.OPERATION);
        calls.push("spawn:" + environment.OPERATION);
        throw marker;
      },
    },
  };
  const provider = new CodexProvider({ host, command: ["fixture-codex", "app-server"] });
  expect(calls).toEqual([]);
  await expect(
    provider.createAgentSession({
      agentWorkspaceDirectory: "/session",
      instructions: "Fixture instructions",
    }),
  ).rejects.toBe(marker);
  await expect(provider.readUsage({ workingDirectory: "/usage" })).rejects.toBe(marker);
  expect(calls).toEqual(["session", "spawn:session", "usage", "spawn:usage"]);
});

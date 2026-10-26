import { expect, test } from "bun:test";
import { ClaudeCodeProvider, type ClaudeRuntimeHost } from "@lrm/coforge-anvil/claude-code";

function unexpected(): never {
  throw new Error("Unexpected fixture host call");
}

function unusedHost(): ClaudeRuntimeHost {
  return {
    processTreeSpawner: { spawn: unexpected },
    buildSessionEnvironment: unexpected,
    createPromptFile: unexpected,
    createReplyIntentScanner: unexpected,
    isShellToolName: unexpected,
    buildUsageEnvironment: unexpected,
    runCli: unexpected,
    spawnUsageProcess: unexpected,
    withUsageCapabilityCache: unexpected,
    maskAccountLabel: unexpected,
    readHostEnvironment: unexpected,
    homeDirectory: unexpected,
    readDirectoryEntries: unexpected,
    readDirectoryNames: unexpected,
    lstat: unexpected,
    readFileTail: unexpected,
    realWorkspaceRoot: unexpected,
    rereadFile: unexpected,
  };
}

test("Claude construction and invalid resume IDs do not invoke host I/O", async () => {
  const provider = new ClaudeCodeProvider({ host: unusedHost(), command: ["fixture-only"] });
  await expect(
    provider.createAgentSession({
      sessionId: " ",
      agentWorkspaceDirectory: "/fixture",
      instructions: "fixture instructions",
    }),
  ).rejects.toThrow("Invalid session ID");
});

test("Claude calls the supplied environment host with its receiver and removes the prompt on failure", async () => {
  const failure = new Error("fixture environment failure");
  const calls: string[] = [];
  const host: ClaudeRuntimeHost = {
    ...unusedHost(),
    async createPromptFile(instructions) {
      expect(this).toBe(host);
      expect(instructions).toBe("fixture instructions");
      calls.push("prompt");
      return {
        path: "/fixture/prompt",
        async remove() {
          calls.push("remove");
        },
      };
    },
    buildSessionEnvironment() {
      expect(this).toBe(host);
      calls.push("environment");
      throw failure;
    },
  };
  const provider = new ClaudeCodeProvider({ host, command: ["fixture-only"] });
  expect(calls).toEqual([]);
  await expect(
    provider.createAgentSession({
      agentWorkspaceDirectory: "/fixture",
      instructions: "fixture instructions",
    }),
  ).rejects.toBe(failure);
  expect(calls).toEqual(["prompt", "environment", "remove"]);
});

test("Claude implementation remains outside the neutral Anvil entry", async () => {
  const neutral = await import("@lrm/coforge-anvil");
  expect("ClaudeCodeProvider" in neutral).toBe(false);
});

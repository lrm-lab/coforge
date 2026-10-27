import { expect, test } from "bun:test";
import { CommandCodeProvider } from "#src/command-code/provider";
import {
  COMMAND_CODE_MIN_CLI_VERSION,
  isCommandCodeVersionUnsupported,
} from "#src/command-code/version";
import { RuntimeVersionUnsupportedError } from "#src/contract";

test("Command Code 1.87.2 is the first CLI that loads --mod on cmd acp", () => {
  expect(COMMAND_CODE_MIN_CLI_VERSION).toBe("1.87.2");
  expect(isCommandCodeVersionUnsupported("1.87.1")).toBe(true);
  expect(isCommandCodeVersionUnsupported("1.87.0")).toBe(true);
  expect(isCommandCodeVersionUnsupported("1.86.9")).toBe(true);
  expect(isCommandCodeVersionUnsupported("1.87.2")).toBe(false);
  expect(isCommandCodeVersionUnsupported("1.87.3")).toBe(false);
  expect(isCommandCodeVersionUnsupported("1.87.10")).toBe(false);
  expect(isCommandCodeVersionUnsupported("1.88.0")).toBe(false);
  expect(isCommandCodeVersionUnsupported("1.10.0")).toBe(true);
  expect(isCommandCodeVersionUnsupported("0.2.1-rc.2")).toBe(false);
  expect(isCommandCodeVersionUnsupported("unknown")).toBe(false);
});

test("a launch refuses a Command Code CLI below 1.87.2 before spawning", async () => {
  let spawned = false;
  const provider = new CommandCodeProvider({
    command: ["cmd"],
    host: {
      clientInfo: { name: "command-code-fixture", version: "1" },
      versionReader: async () => "1.87.1",
      processTreeSpawner: {
        spawn: () => {
          spawned = true;
          throw new Error("should not spawn");
        },
      },
      buildEnvironment: () => ({}),
      buildCatalogEnvironment: () => ({}),
      createReplyIntentScanner: () => ({
        feed: () => undefined,
        complete: () => {},
        reset: () => [],
      }),
      isShellToolName: () => false,
    },
  });
  await expect(
    provider.createAgentSession({
      agentWorkspaceDirectory: "/tmp",
      instructions: "briefing",
    }),
  ).rejects.toThrow(RuntimeVersionUnsupportedError);
  expect(spawned).toBe(false);
});

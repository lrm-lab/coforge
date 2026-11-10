import { expect, test } from "bun:test";
import { createRunnerCommand } from "#src/runners/runner-command";

test("runner list resolves a local Workspace and renders JSON", async () => {
  const output: string[] = [];
  const calls: string[] = [];
  const command = createRunnerCommand({
    daemon: {
      ensureRunning: async () => {
        calls.push("ensure");
      },
      runners: async (operation, workspaceId) => {
        calls.push(`${operation}:${workspaceId}`);
        return [
          {
            workspaceId: "workspace-a",
            agentId: "agent-a",
            provider: "pi",
            model: "default",
            state: "running",
          },
        ];
      },
    },
    resolveWorkspace: async (selector) => ({ id: "workspace-a", slug: selector }),
    write: (line) => output.push(line),
  });

  await command.list("team", { json: true });
  expect(calls).toEqual(["ensure", "list:workspace-a"]);
  expect(JSON.parse(output[0]!)).toEqual({
    runners: [expect.objectContaining({ agentId: "agent-a", workspaceId: "workspace-a" })],
  });
});

test("runner stop refuses an unscoped target", async () => {
  const command = createRunnerCommand({
    daemon: { ensureRunning: async () => {}, runners: async () => [] },
  });
  await expect(command.stop("agent-a", undefined, { json: false })).rejects.toMatchObject({
    code: "RUNNER_WORKSPACE_REQUIRED",
  });
});

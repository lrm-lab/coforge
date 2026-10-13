import { describe, expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCoforgeSessionDir, prepareAgentSessionDirectory } from "#src/paths";
import { exportAgentTrainingTrajectory } from "#src/training-trajectory";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("exportAgentTrainingTrajectory", () => {
  test("keeps recall tools and shell tools from one agent session", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "coforge-train-")));
    const sessionDir = getCoforgeSessionDir(cwd);
    const workspace = await prepareAgentSessionDirectory(cwd, sessionDir);
    const session = SessionManager.create(workspace, sessionDir, { id: "train-1" });
    const now = Date.now();
    session.appendMessage({ role: "user", content: "部署用蓝绿", timestamp: now });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "ov_find", arguments: { query: "蓝绿" } }],
      api: "openai-completions",
      provider: "openai",
      model: "test",
      usage,
      stopReason: "toolUse",
      timestamp: now + 1,
    });
    session.appendMessage({
      role: "toolResult",
      toolCallId: "c1",
      toolName: "ov_find",
      content: [{ type: "text", text: "发布必须蓝绿" }],
      isError: false,
      timestamp: now + 2,
    });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "c2", name: "shell", arguments: { command: "echo ok" } }],
      api: "openai-completions",
      provider: "openai",
      model: "test",
      usage,
      stopReason: "toolUse",
      timestamp: now + 3,
    });
    session.appendMessage({
      role: "toolResult",
      toolCallId: "c2",
      toolName: "shell",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: now + 4,
    });

    const trajectory = await exportAgentTrainingTrajectory({ cwd, sessionId: "train-1" });

    expect(trajectory.sessionId).toBe("train-1");
    expect(trajectory.steps).toEqual([
      { kind: "user", text: "部署用蓝绿" },
      {
        kind: "tool",
        toolCallId: "c1",
        toolName: "ov_find",
        input: { query: "蓝绿" },
        output: "发布必须蓝绿",
        isError: false,
      },
      {
        kind: "tool",
        toolCallId: "c2",
        toolName: "shell",
        input: { command: "echo ok" },
        output: "ok",
        isError: false,
      },
    ]);
  });
});

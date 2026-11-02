import { describe, expect, test } from "bun:test";
import { AgentDetailQuery } from "#src/server/agents/agent-detail.server";
import { agentControlRevision } from "#src/server/agents/agent-control.server";

const runtimeConfig = {
  runtime: "codex",
  provider: { kind: "default" },
  model: "gpt-5",
};

const baseAgent = {
  id: "agent-1",
  workspaceId: "workspace-1",
  name: "assistant",
  displayName: "Assistant",
  role: "member",
  createdAt: new Date("2026-11-02T00:00:00Z"),
  owner: { id: "user-1", username: "alice" },
  runtimeConfig,
};

describe("AgentDetailQuery failureReason", () => {
  test("surfaces typed failure reason when agent controlState is failed and current", async () => {
    const revision = agentControlRevision(runtimeConfig);
    const query = new AgentDetailQuery({
      findAuthorized: async () => ({
        ...baseAgent,
        controlState: {
          phase: "failed",
          errorCode: "runtime_private",
          configRevision: revision,
        },
      }),
    });

    const detail = await query.get("workspace-1", "agent-1", "user-1");
    expect(detail?.failureReason).toBe("runtime_private");
  });

  test("returns null when controlState phase is not failed", async () => {
    const revision = agentControlRevision(runtimeConfig);
    const query = new AgentDetailQuery({
      findAuthorized: async () => ({
        ...baseAgent,
        controlState: {
          phase: "completed",
          configRevision: revision,
        },
      }),
    });

    const detail = await query.get("workspace-1", "agent-1", "user-1");
    expect(detail?.failureReason).toBeNull();
  });

  test("returns null when runtime config was updated so failure is no longer current", async () => {
    const oldRevision = agentControlRevision({ runtime: "pi", model: "old" });
    const query = new AgentDetailQuery({
      findAuthorized: async () => ({
        ...baseAgent,
        controlState: {
          phase: "failed",
          errorCode: "runtime_private",
          configRevision: oldRevision,
        },
      }),
    });

    const detail = await query.get("workspace-1", "agent-1", "user-1");
    expect(detail?.failureReason).toBeNull();
  });
});

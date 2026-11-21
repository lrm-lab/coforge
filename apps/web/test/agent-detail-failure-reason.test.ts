import { describe, expect, test } from "bun:test";
import { STALLED_RESTART_LIMIT_ERROR } from "@lrm/coforge-sdk/internal";
import { AgentDetailQuery } from "#src/server/agents/agent-detail.server";
import { AgentControlEvents } from "#src/server/agents/agent-control-events.server";
import { AgentControlOperations } from "#src/server/agents/agent-control-operations.server";
import { AgentControlReceiver } from "#src/server/agents/agent-control-receiver.server";
import { LocalAgentControlSignal } from "#src/server/agents/agent-control-signal.server";
import {
  agentControlRevision,
  AUTOMATIC_START_STREAK_LIMIT,
  type AgentControlState,
} from "#src/server/agents/agent-control-types.server";
import { parseAgentRuntimeConfig } from "#src/server/agents/agent-runtime-config.server";
import { pendingOpStore } from "./helpers/agent-control-store";

const runtimeConfig = {
  model: "gpt-5",
  runtime: "codex",
  provider: { kind: "default" },
  reasoning: "",
  modelProvider: "",
};
const runtimeConfigRevision = agentControlRevision(parseAgentRuntimeConfig(runtimeConfig));

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
    const query = new AgentDetailQuery({
      findAuthorized: async () => ({
        ...baseAgent,
        controlState: {
          phase: "failed",
          errorCode: "runtime_private",
          configRevision: runtimeConfigRevision,
        },
      }),
    });

    const detail = await query.get("workspace-1", "agent-1", "user-1");
    expect(detail?.failureReason).toBe("runtime_private");
    expect(detail?.needsManualStart).toBe(false);
  });

  test("a fresh detail read reports the retry limit and clears it after a person's Start", async () => {
    const failed: AgentControlState = {
      version: 1,
      protocolMajor: 1,
      workspaceId: baseAgent.workspaceId,
      agentId: baseAgent.id,
      computerId: "computer-1",
      provider: "codex",
      action: "start",
      requestId: "auto-start",
      epoch: 1,
      phase: "failed",
      configRevision: runtimeConfigRevision,
      controlSequence: 0,
      sessionSequence: 0,
      errorCode: "launch_failed",
      failedStreak: 1,
    };
    const { store, current } = pendingOpStore({
      id: failed.agentId,
      workspaceId: failed.workspaceId,
      computerId: failed.computerId,
      ownerId: baseAgent.owner.id,
      visibility: "public",
      runtimeConfig: parseAgentRuntimeConfig(runtimeConfig),
      state: failed,
    });
    const query = new AgentDetailQuery({
      findAuthorized: async () => ({ ...baseAgent, controlState: current().state }),
    });
    const read = () => query.get(baseAgent.workspaceId, baseAgent.id, baseAgent.owner.id);
    expect(await read()).toMatchObject({ failureReason: "launch_failed", needsManualStart: false });

    const published: unknown[] = [];
    const events = new AgentControlEvents({
      publishJson: async (_channel, event) => void published.push(event),
    });
    const operations = new AgentControlOperations(store, {} as never, events);
    const retry = await operations.begin(current(), "start", "automatic-retry", 1, undefined, true);
    const receiver = new AgentControlReceiver(
      store,
      new LocalAgentControlSignal(),
      { run: async (_id: string, work: () => Promise<void>) => work() } as never,
      undefined,
      undefined,
      events,
    );
    const { requestId, workspaceId, computerId, agentId, provider, epoch, protocolMajor } = retry;
    await receiver.result(
      { workspaceId, computerId },
      {
        requestId,
        workspaceId,
        computerId,
        agentId,
        provider,
        epoch,
        protocolMajor,
        sequence: 1,
        phase: "failed",
        errorCode: "launch_failed",
      },
    );
    expect(current().state?.failedStreak).toBe(AUTOMATIC_START_STREAK_LIMIT);
    expect(published).toContainEqual(expect.objectContaining({ requestId, phase: "failed" }));
    expect(await read()).toMatchObject({ failureReason: "launch_failed", needsManualStart: true });

    await operations.begin(current(), "start", "manual-start");
    expect(current().state?.phase).toBe("starting");
    expect(await read()).toMatchObject({ failureReason: null, needsManualStart: false });
  });

  test("returns null when controlState phase is not failed", async () => {
    const query = new AgentDetailQuery({
      findAuthorized: async () => ({
        ...baseAgent,
        controlState: {
          phase: "completed",
          configRevision: runtimeConfigRevision,
          failedStreak: AUTOMATIC_START_STREAK_LIMIT,
        },
      }),
    });

    const detail = await query.get("workspace-1", "agent-1", "user-1");
    expect(detail?.failureReason).toBeNull();
    expect(detail?.needsManualStart).toBe(false);
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
          failedStreak: AUTOMATIC_START_STREAK_LIMIT,
        },
      }),
    });

    const detail = await query.get("workspace-1", "agent-1", "user-1");
    expect(detail?.failureReason).toBeNull();
    expect(detail?.needsManualStart).toBe(false);
  });

  test("surfaces stalled_restart_limit when agent has recent runtime_stalled activity with limit reason", async () => {
    const query = new AgentDetailQuery({
      findAuthorized: async () => ({
        ...baseAgent,
        latestActivity: {
          detailKind: "runtime_stalled",
          runtimeErrorReason: STALLED_RESTART_LIMIT_ERROR.errorReason,
        },
      }),
    });

    const detail = await query.get("workspace-1", "agent-1", "user-1");
    expect(detail?.failureReason).toBe(STALLED_RESTART_LIMIT_ERROR.errorReason);
    expect(detail?.needsManualStart).toBe(false);
  });

  test("returns null when runtime_stalled activity is from an unrelated error reason", async () => {
    const query = new AgentDetailQuery({
      findAuthorized: async () => ({
        ...baseAgent,
        latestActivity: {
          detailKind: "runtime_stalled",
          runtimeErrorReason: "other_reason",
        },
      }),
    });

    const detail = await query.get("workspace-1", "agent-1", "user-1");
    expect(detail?.failureReason).toBeNull();
  });

  test("returns null when recent activity was stalled but live display has moved on", async () => {
    const query = new AgentDetailQuery(
      {
        findAuthorized: async () => ({
          ...baseAgent,
          computerId: "computer-1",
          latestActivity: {
            detailKind: "runtime_stalled",
            runtimeErrorReason: STALLED_RESTART_LIMIT_ERROR.errorReason,
          },
        }),
      },
      undefined,
      {
        snapshot: async () =>
          ({
            protocolMajor: 1,
            workspaceId: "workspace-1",
            computerId: "computer-1",
            agentId: "agent-1",
            revision: 2,
            activityKind: "working",
            detailKind: "running_command",
            detail: "Running...",
            entries: [],
            expiresAt: null,
          }) as any,
      },
    );

    const detail = await query.get("workspace-1", "agent-1", "user-1");
    expect(detail?.failureReason).toBeNull();
  });

  test("returns null for stalled limit when agent is stopped", async () => {
    const query = new AgentDetailQuery({
      findAuthorized: async () => ({
        ...baseAgent,
        stoppedAt: new Date("2026-11-02T01:00:00Z"),
        latestActivity: {
          detailKind: "runtime_stalled",
          runtimeErrorReason: STALLED_RESTART_LIMIT_ERROR.errorReason,
        },
      }),
    });

    const detail = await query.get("workspace-1", "agent-1", "user-1");
    expect(detail?.failureReason).toBeNull();
  });
});

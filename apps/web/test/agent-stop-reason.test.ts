import { expect, test } from "bun:test";
import { createAgentStopReasonRecorder } from "#src/server/agents/agent-stop-reason.server";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

const snapshot = {
  protocolMajor: 1,
  workspaceId: "w",
  computerId: "c",
  agentId: "a",
  revision: 1,
  activityKind: "offline",
  detailKind: "",
  detail: "",
  entries: [],
  expiresAt: null,
  stopReason: "runtime_login_required",
} as AgentDisplaySnapshot;

const agent = { id: "a", workspaceId: "w", computerId: "c", visibility: "public" };

test("a recorded reason publishes the full snapshot on the shared channel for a public Agent", async () => {
  const published: Array<{ channel: string; data: unknown }> = [];
  const record = createAgentStopReasonRecorder({
    display: {
      recordStopReason: async (_scope, reason) => {
        expect(reason).toBe("runtime_login_required");
        return snapshot;
      },
    },
    publishJson: async (channel, data) => {
      published.push({ channel, data });
    },
  });
  await record(agent, "runtime_login_required");
  expect(published).toHaveLength(1);
  expect(published[0]!.channel).toBe("agentstatus:w");
  expect(published[0]!.data).toMatchObject({
    type: "agent:display",
    agentId: "a",
    stopReason: "runtime_login_required",
  });
});

test("a private Agent's snapshot goes to its own channel plus the status floor on the shared one", async () => {
  const published: Array<{ channel: string; data: Record<string, unknown> }> = [];
  const record = createAgentStopReasonRecorder({
    display: { recordStopReason: async () => snapshot },
    publishJson: async (channel, data) => {
      published.push({ channel, data: data as Record<string, unknown> });
    },
  });
  await record({ ...agent, visibility: "private" }, "runtime_login_required");
  expect(published.map((entry) => entry.channel)).toEqual(["agentstatus:w:a", "agentstatus:w"]);
  expect(published[0]!.data.detail).toBe("");
  expect(published[1]!.data).toMatchObject({
    statusOnly: true,
    stopReason: "runtime_login_required",
  });
});

test("a rejected or unchanged display write publishes nothing", async () => {
  const published: unknown[] = [];
  const record = createAgentStopReasonRecorder({
    display: { recordStopReason: async () => undefined },
    publishJson: async (_channel, data) => {
      published.push(data);
    },
  });
  await record(agent, "runtime_login_required");
  expect(published).toEqual([]);
});

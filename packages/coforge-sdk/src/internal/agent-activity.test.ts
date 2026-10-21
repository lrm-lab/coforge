import { expect, test } from "bun:test";

import {
  AGENT_ACTIVITY_DETAIL_KIND,
  decodeAgentActivity,
  encodeAgentActivity,
  type AgentActivity,
} from "./index";

const activity: AgentActivity = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  agentId: "agent-1",
  detailKind: "tool_started",
  level: "info",
  detail: "tool",
  observedAtMs: Date.parse("2026-08-29T00:00:00.000Z"),
  launchId: "launch-1",
  clientSeq: 1,
  activityKind: "working",
  runtimeError: {
    errorClass: "CodexAuthError",
    errorReason: "turn_failed",
    fingerprint: "deadbeef",
  },
};

test("round trips the launch ordering identity", () => {
  expect(decodeAgentActivity(encodeAgentActivity(activity))).toEqual(activity);
});

test("rejects incomplete or invalid launch ordering identity", () => {
  for (const invalid of [
    { ...activity, launchId: "" },
    { ...activity, clientSeq: 0 },
    { ...activity, clientSeq: 1.5 },
    { ...activity, observedAtMs: NaN },
  ])
    expect(() => encodeAgentActivity(invalid)).toThrow("invalid agent activity");
});

test("round trips a busy heartbeat re-send of the same activity frame", () => {
  const heartbeat: AgentActivity = {
    ...activity,
    detailKind: "runtime_progress",
    clientSeq: 2,
    isHeartbeat: true,
    entries: [],
  };
  delete (heartbeat as { runtimeError?: unknown }).runtimeError;
  const decoded = decodeAgentActivity(encodeAgentActivity(heartbeat));
  expect(decoded.isHeartbeat).toBe(true);
  expect(decoded.detailKind).toBe("runtime_progress");
});

test("omits isHeartbeat on decode when the frame was not a heartbeat", () => {
  const decoded = decodeAgentActivity(encodeAgentActivity(activity));
  expect(decoded.isHeartbeat).toBeUndefined();
});

test("round trips a probe reply's probeId", () => {
  const probeReply: AgentActivity = { ...activity, probeId: "probe-1" };
  const decoded = decodeAgentActivity(encodeAgentActivity(probeReply));
  expect(decoded.probeId).toBe("probe-1");
});

test("omits probeId on decode when the frame was not a probe reply", () => {
  const decoded = decodeAgentActivity(encodeAgentActivity(activity));
  expect(decoded.probeId).toBeUndefined();
});

// Each new detail kind round-trips through the codec exactly like
// any other stable string value; detail_kind is a plain proto string field.
for (const detailKind of [
  AGENT_ACTIVITY_DETAIL_KIND.TOOL_END,
  AGENT_ACTIVITY_DETAIL_KIND.THINKING_END,
  AGENT_ACTIVITY_DETAIL_KIND.COMPACTING_CONTEXT,
  AGENT_ACTIVITY_DETAIL_KIND.COMPACTION_FINISHED,
  AGENT_ACTIVITY_DETAIL_KIND.SUBAGENT_ACTIVITY,
  AGENT_ACTIVITY_DETAIL_KIND.MESSAGE_RECEIVED,
  AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_CRASHED,
  AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_INTERRUPTED,
  // This change's additions to the shared vocabulary.
  AGENT_ACTIVITY_DETAIL_KIND.REVIEWING_CHANGES,
  AGENT_ACTIVITY_DETAIL_KIND.REVIEW_FINISHED,
  AGENT_ACTIVITY_DETAIL_KIND.COMPACTION_STALE,
  AGENT_ACTIVITY_DETAIL_KIND.REVIEW_STALE,
  AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_STALLED,
  AGENT_ACTIVITY_DETAIL_KIND.STALLED_RECOVERY,
  AGENT_ACTIVITY_DETAIL_KIND.SYSTEM_MESSAGE,
  AGENT_ACTIVITY_DETAIL_KIND.FAST_MODE_UNAVAILABLE,
]) {
  test(`round trips the ${detailKind} detail kind`, () => {
    const withKind: AgentActivity = { ...activity, detailKind };
    const decoded = decodeAgentActivity(encodeAgentActivity(withKind));
    expect(decoded.detailKind).toBe(detailKind);
  });
}

test("round trips a tool_start entry's toolInput", () => {
  const withEntry: AgentActivity = {
    ...activity,
    entries: [{ kind: "tool_start", toolName: "bash", toolInput: "ls -la /tmp" }],
  };
  const decoded = decodeAgentActivity(encodeAgentActivity(withEntry));
  expect(decoded.entries).toEqual([
    { kind: "tool_start", toolName: "bash", toolInput: "ls -la /tmp" },
  ]);
});

test("omits toolInput on decode when a tool_start entry did not carry one", () => {
  const withEntry: AgentActivity = {
    ...activity,
    entries: [{ kind: "tool_start", toolName: "bash" }],
  };
  const decoded = decodeAgentActivity(encodeAgentActivity(withEntry));
  expect(decoded.entries).toEqual([{ kind: "tool_start", toolName: "bash" }]);
  expect(decoded.entries?.[0]).not.toHaveProperty("toolInput");
});

test("round trips a system entry", () => {
  const withEntry: AgentActivity = {
    ...activity,
    entries: [
      { kind: "system", title: "Session reset", text: "The daemon restarted the session." },
    ],
  };
  const decoded = decodeAgentActivity(encodeAgentActivity(withEntry));
  expect(decoded.entries).toEqual([
    { kind: "system", title: "Session reset", text: "The daemon restarted the session." },
  ]);
});

test("round trips a subagent lineage's subagentType", () => {
  const withEntry: AgentActivity = {
    ...activity,
    entries: [
      {
        kind: "tool_start",
        toolName: "read_file",
        subagent: { parentToolUseId: "toolu_1", subagentType: "Explore" },
      },
      { kind: "text", text: "found it", subagent: { parentToolUseId: "toolu_1" } },
    ],
  };
  const decoded = decodeAgentActivity(encodeAgentActivity(withEntry));
  expect(decoded.entries).toEqual([
    {
      kind: "tool_start",
      toolName: "read_file",
      subagent: { parentToolUseId: "toolu_1", subagentType: "Explore" },
    },
    { kind: "text", text: "found it", subagent: { parentToolUseId: "toolu_1" } },
  ]);
  expect(decoded.entries?.[1]?.subagent).not.toHaveProperty("subagentType");
});

test("round trips a tool_start entry's callId", () => {
  const withEntry: AgentActivity = {
    ...activity,
    entries: [{ kind: "tool_start", toolName: "bash", toolInput: "ls", callId: "call-1" }],
  };
  expect(decodeAgentActivity(encodeAgentActivity(withEntry)).entries).toEqual([
    { kind: "tool_start", toolName: "bash", toolInput: "ls", callId: "call-1" },
  ]);
});

test("omits callId on decode when a tool_start entry did not carry one", () => {
  const withEntry: AgentActivity = {
    ...activity,
    entries: [{ kind: "tool_start", toolName: "bash" }],
  };
  expect(decodeAgentActivity(encodeAgentActivity(withEntry)).entries?.[0]).not.toHaveProperty(
    "callId",
  );
});

const toolEnd: AgentActivity = {
  protocolMajor: 1,
  requestId: "request-2",
  workspaceId: "workspace-1",
  agentId: "agent-1",
  detailKind: AGENT_ACTIVITY_DETAIL_KIND.TOOL_END,
  level: "info",
  detail: "Tool finished",
  observedAtMs: Date.parse("2026-08-29T00:00:01.000Z"),
  launchId: "launch-1",
  clientSeq: 2,
};

test("round trips a tool_end frame's outcome, exit code and duration included", () => {
  const finished: AgentActivity = {
    ...toolEnd,
    toolOutcome: { callId: "call-1", ok: false, durationMs: 1234, exitCode: 2 },
  };
  expect(decodeAgentActivity(encodeAgentActivity(finished))).toEqual(finished);
});

test("round trips an outcome with no duration or exit code, and a zero exit code", () => {
  const bare: AgentActivity = { ...toolEnd, toolOutcome: { callId: "call-1", ok: true } };
  const decoded = decodeAgentActivity(encodeAgentActivity(bare));
  expect(decoded).toEqual(bare);
  expect(decoded.toolOutcome).not.toHaveProperty("durationMs");
  expect(decoded.toolOutcome).not.toHaveProperty("exitCode");
  const zero: AgentActivity = {
    ...toolEnd,
    toolOutcome: { callId: "call-1", ok: true, durationMs: 0, exitCode: 0 },
  };
  expect(decodeAgentActivity(encodeAgentActivity(zero))).toEqual(zero);
});

test("a tool_end frame without an outcome, as an older daemon sends it, still decodes", () => {
  const decoded = decodeAgentActivity(encodeAgentActivity(toolEnd));
  expect(decoded).toEqual(toolEnd);
  expect(decoded).not.toHaveProperty("toolOutcome");
});

test("rejects an outcome on a frame that is not a tool_end, or an invalid outcome", () => {
  for (const invalid of [
    { ...activity, toolOutcome: { callId: "call-1", ok: true } },
    { ...toolEnd, toolOutcome: { callId: "", ok: true } },
    { ...toolEnd, toolOutcome: { callId: "call\x00", ok: true } },
    { ...toolEnd, toolOutcome: { callId: "call-1", ok: "yes" } },
    { ...toolEnd, toolOutcome: { callId: "call-1", ok: true, durationMs: -1 } },
    { ...toolEnd, toolOutcome: { callId: "call-1", ok: true, durationMs: 1.5 } },
    { ...toolEnd, toolOutcome: { callId: "call-1", ok: true, exitCode: 1.5 } },
    { ...toolEnd, toolOutcome: { callId: "call-1", ok: true, exitCode: 2 ** 31 } },
  ])
    expect(() => encodeAgentActivity(invalid as AgentActivity)).toThrow("invalid agent activity");
});

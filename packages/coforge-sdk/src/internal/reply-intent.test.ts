import { expect, test } from "bun:test";

import {
  REPLY_INTENT_PHASE,
  decodeAgentActivityFrame,
  encodeAgentReplyIntent,
  isReplyIntentTarget,
  type AgentReplyIntent,
} from "./reply-intent";
import { decodeAgentActivity, encodeAgentActivity, type AgentActivity } from "./index";

/** The reply intent a frame carries; fails the test for any other frame. */
function replyIntentOf(bytes: Uint8Array): AgentReplyIntent {
  const frame = decodeAgentActivityFrame(bytes);
  if (!("replyIntent" in frame)) throw new Error("not a reply intent frame");
  return frame.replyIntent;
}

const start: AgentReplyIntent = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  agentId: "agent-1",
  observedAtMs: Date.parse("2026-10-24T00:00:00.000Z"),
  intent: { phase: REPLY_INTENT_PHASE.START, callId: "call-1", target: "#general:ab12cd34" },
};

test("a start carrying the Agent's raw target round trips", () => {
  expect(replyIntentOf(encodeAgentReplyIntent(start))).toEqual(start);
});

test("an end needs only the call id, and may repeat the target its start announced", () => {
  const end: AgentReplyIntent = {
    ...start,
    intent: { phase: REPLY_INTENT_PHASE.END, callId: "call-1" },
  };
  expect(replyIntentOf(encodeAgentReplyIntent(end))).toEqual(end);
  const withTarget: AgentReplyIntent = {
    ...end,
    intent: { ...end.intent, target: "@frank" },
  };
  expect(replyIntentOf(encodeAgentReplyIntent(withTarget))).toEqual(withTarget);
});

test("the early flag and the server's resolved conversation and thread root round trip", () => {
  const relayed: AgentReplyIntent = {
    ...start,
    intent: {
      phase: REPLY_INTENT_PHASE.START,
      callId: "call-2",
      early: true,
      conversationId: "conversation-1",
      threadRootId: "message-1",
    },
  };
  expect(replyIntentOf(encodeAgentReplyIntent(relayed))).toEqual(relayed);
});

test("an ordinary Activity frame decodes once, as Activity", () => {
  const activity: AgentActivity = {
    protocolMajor: 1,
    requestId: "request-1",
    workspaceId: "workspace-1",
    agentId: "agent-1",
    detailKind: "tool_started",
    level: "info",
    detail: "tool",
    observedAtMs: 1,
    launchId: "launch-1",
    clientSeq: 1,
  };
  expect(decodeAgentActivityFrame(encodeAgentActivity(activity))).toEqual({ activity });
});

test("a reply intent is not an Activity observation, so a reader that predates it rejects it", () => {
  expect(() => decodeAgentActivity(encodeAgentReplyIntent(start))).toThrow();
});

test("bytes that are not a frame are rejected, not mistaken for an ordinary Activity", () => {
  expect(() => decodeAgentActivityFrame(Uint8Array.from([0xff, 0xff, 0xff]))).toThrow();
});

test("a frame that is neither a valid reply intent nor a valid Activity is rejected", () => {
  const invalid = encodeAgentReplyIntent(start);
  // Decoded as an ordinary observation it lacks a launch; as a reply intent it is fine.
  expect(() => decodeAgentActivity(invalid)).toThrow();
  expect(replyIntentOf(invalid)).toEqual(start);
});

test("the target limit is 200 code points", () => {
  expect(isReplyIntentTarget(`#${"a".repeat(199)}`)).toBe(true);
  expect(isReplyIntentTarget(`#${"a".repeat(200)}`)).toBe(false);
  expect(isReplyIntentTarget("#😀".repeat(100))).toBe(true);
  expect(isReplyIntentTarget("")).toBe(false);
});

test.each([
  ["a protocol major other than 1", { ...start, protocolMajor: 2 }],
  ["no workspace", { ...start, workspaceId: "" }],
  ["no Agent", { ...start, agentId: "" }],
  ["no request id", { ...start, requestId: "" }],
  ["no observation time", { ...start, observedAtMs: 0 }],
  ["an unknown phase", { ...start, intent: { ...start.intent, phase: "pause" as "start" } }],
  ["no call id", { ...start, intent: { ...start.intent, callId: "" } }],
  [
    "a call id over 128 characters",
    { ...start, intent: { ...start.intent, callId: "c".repeat(129) } },
  ],
  ["a call id with a control character", { ...start, intent: { ...start.intent, callId: "a\nb" } }],
  [
    "a start with neither a target nor a conversation",
    { ...start, intent: { phase: "start" as const, callId: "call-1" } },
  ],
  [
    "a target over 200 characters",
    { ...start, intent: { ...start.intent, target: `#${"a".repeat(200)}` } },
  ],
  [
    "a thread root without its conversation",
    { ...start, intent: { ...start.intent, threadRootId: "message-1" } },
  ],
] as const)("refuses to encode %s", (_name, frame) => {
  expect(() => encodeAgentReplyIntent(frame as AgentReplyIntent)).toThrow();
});

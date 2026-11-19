import { describe, expect, test } from "bun:test";
import {
  AGENT_SIDE_ASK_ANSWER_MAX_CHARS,
  AGENT_SIDE_ASK_CAPABILITY,
  AGENT_SIDE_ASK_DEFAULT_TIMEOUT_MS,
  AGENT_SIDE_ASK_MAX_TIMEOUT_MS,
  AGENT_SIDE_ASK_QUESTION_MAX_CHARS,
  AGENT_SIDE_ASK_RESULT_METHOD,
  decodeAgentSideAskRequest,
  decodeAgentSideAskResult,
  encodeAgentSideAskRequest,
  encodeAgentSideAskResult,
  isAgentSideAskRequest,
  type AgentSideAskRequest,
  type AgentSideAskResult,
} from "./agent-side-ask";
import { RPC_METHODS } from "./rpc-methods";

function sampleRequest(overrides: Partial<AgentSideAskRequest> = {}): AgentSideAskRequest {
  return {
    protocolMajor: 1,
    requestId: "sask_0123456789abcdef0123456789abcdef",
    workspaceId: "ws-1",
    computerId: "comp-1",
    agentId: "agent-1",
    kind: "question",
    question: "What file are you currently editing?",
    timeoutMs: AGENT_SIDE_ASK_DEFAULT_TIMEOUT_MS,
    asker: {
      userId: "user-1",
      displayName: "Frank",
      role: "owner",
      isAgentOwner: true,
    },
    ...overrides,
  };
}

function sampleResult(overrides: Partial<AgentSideAskResult> = {}): AgentSideAskResult {
  return {
    protocolMajor: 1,
    requestId: "sask_0123456789abcdef0123456789abcdef",
    workspaceId: "ws-1",
    computerId: "comp-1",
    agentId: "agent-1",
    askerUserId: "user-1",
    kind: "question",
    status: "ok",
    answer: "I am updating the test suite for agent-side-ask.",
    runtime: "claude-code",
    durationMs: 1420,
    ...overrides,
  };
}

describe("agent-side-ask wire codec", () => {
  test("exports capability and RPC method constants", () => {
    expect(AGENT_SIDE_ASK_CAPABILITY).toBe("agent-side-ask:v1");
    expect(AGENT_SIDE_ASK_RESULT_METHOD).toBe(RPC_METHODS.daemonAgentSideAskResult);
  });

  test("round-trips question and status requests", () => {
    const question = sampleRequest();
    const encodedQuestion = encodeAgentSideAskRequest(question);
    expect(isAgentSideAskRequest(encodedQuestion)).toBe(true);
    expect(decodeAgentSideAskRequest(encodedQuestion)).toEqual(question);

    const status = sampleRequest({ kind: "status", question: "" });
    const encodedStatus = encodeAgentSideAskRequest(status);
    expect(isAgentSideAskRequest(encodedStatus)).toBe(true);
    expect(decodeAgentSideAskRequest(encodedStatus)).toEqual(status);
  });

  test("round-trips ok and failed results", () => {
    const ok = sampleResult();
    expect(decodeAgentSideAskResult(encodeAgentSideAskResult(ok))).toEqual(ok);

    const failed = sampleResult({
      status: "failed",
      reason: "context_too_large",
      answer: "",
      durationMs: 12,
    });
    expect(decodeAgentSideAskResult(encodeAgentSideAskResult(failed))).toEqual(failed);
  });

  test("rejects malformed requests and bounds violations", () => {
    expect(() => encodeAgentSideAskRequest(sampleRequest({ protocolMajor: 2 }))).toThrow();
    expect(() => encodeAgentSideAskRequest(sampleRequest({ requestId: "bad-id" }))).toThrow();
    expect(() => encodeAgentSideAskRequest(sampleRequest({ question: "   " }))).toThrow();
    expect(() =>
      encodeAgentSideAskRequest(
        sampleRequest({ question: "x".repeat(AGENT_SIDE_ASK_QUESTION_MAX_CHARS + 1) }),
      ),
    ).toThrow();
    expect(() =>
      encodeAgentSideAskRequest(sampleRequest({ kind: "status", question: "unexpected" })),
    ).toThrow();
    expect(() =>
      encodeAgentSideAskRequest(sampleRequest({ timeoutMs: AGENT_SIDE_ASK_MAX_TIMEOUT_MS + 1 })),
    ).toThrow();
    expect(() =>
      encodeAgentSideAskRequest(
        sampleRequest({
          asker: { userId: "user-1", displayName: " ", role: "member", isAgentOwner: false },
        }),
      ),
    ).toThrow();
  });

  test("rejects malformed results and mismatched status/reason/answer", () => {
    expect(() => encodeAgentSideAskResult(sampleResult({ answer: "" }))).toThrow();
    expect(() =>
      encodeAgentSideAskResult(
        sampleResult({ answer: "a".repeat(AGENT_SIDE_ASK_ANSWER_MAX_CHARS + 1) }),
      ),
    ).toThrow();
    expect(() =>
      encodeAgentSideAskResult(sampleResult({ status: "ok", reason: "busy" })),
    ).toThrow();
    expect(() =>
      encodeAgentSideAskResult(sampleResult({ status: "failed", reason: undefined, answer: "" })),
    ).toThrow();
    expect(() =>
      encodeAgentSideAskResult(sampleResult({ status: "failed", reason: "timeout", answer: "no" })),
    ).toThrow();
  });

  test("isAgentSideAskRequest distinguishes unrelated traffic and truncated claims", () => {
    expect(isAgentSideAskRequest(new Uint8Array([1, 2, 3]))).toBe(false);
    const valid = encodeAgentSideAskRequest(sampleRequest());
    const truncatedWithClaim = new Uint8Array([...valid, 0xff, 0xff]);
    expect(isAgentSideAskRequest(truncatedWithClaim)).toBe(true);
    expect(() => decodeAgentSideAskRequest(truncatedWithClaim)).toThrow();
  });
});

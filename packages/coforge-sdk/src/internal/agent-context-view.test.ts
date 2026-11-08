import { describe, expect, test } from "bun:test";
import {
  decodeAgentContextViewRequest,
  decodeAgentContextViewResult,
  encodeAgentContextViewRequest,
  encodeAgentContextViewResult,
} from "./agent-context-view";

const request = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
  messageId: "message-1",
  sessionId: "session-1",
};

describe("agent context view wire codec", () => {
  test("round trips scoped requests", () => {
    expect(decodeAgentContextViewRequest(encodeAgentContextViewRequest(request))).toEqual(request);
  });

  test("round trips bounded gzip results", () => {
    const value = {
      ...request,
      status: "ok" as const,
      provider: "codex",
      createdAtMs: 123,
      content: new TextEncoder().encode("context"),
      encoding: "gzip" as const,
    };
    const result = decodeAgentContextViewResult(encodeAgentContextViewResult(value));
    expect(result).toEqual(value);
  });

  test("rejects mismatched identities and oversized content", () => {
    expect(() => encodeAgentContextViewRequest({ ...request, agentId: "" })).toThrow();
    expect(() => encodeAgentContextViewResult({
      ...request,
      status: "ok",
      createdAtMs: 1,
      content: new Uint8Array(32 * 1024 * 1024 + 1),
      encoding: "identity",
    })).toThrow();
  });
});

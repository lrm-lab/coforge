import { describe, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  AGENT_CONTEXT_VIEW_FAILURE_REASONS,
  decodeAgentContextViewAvailability,
  decodeAgentContextViewRequest,
  decodeAgentContextViewResult,
  encodeAgentContextViewRequest,
  encodeAgentContextViewResult,
  encodeAgentContextViewAvailability,
} from "./agent-context-view";
import { AgentContextViewResultSchema } from "./gen/coforge/rpc/v1/agent_context_view_pb";

const request = {
  protocolMajor: 1,
  requestId: "ctxv_1234567890abcdef",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
  messageId: "message-1",
  sessionId: "session-1",
  maxBytes: 1024,
};

describe("agent context view wire codec", () => {
  test("exports Raft's closed failure-reason set", () => {
    expect(AGENT_CONTEXT_VIEW_FAILURE_REASONS).toEqual([
      "offline",
      "old_daemon",
      "agent_moved",
      "not_found",
      "expired",
      "unsupported_runtime",
      "too_large",
      "read_failed",
      "no_computer",
      "context_mismatch",
      "media_removed",
      "newer_session_format",
      "not_recorded",
    ]);
  });

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

  test("round trips Raft restore observability fields", () => {
    const value = {
      ...request,
      status: "ok" as const,
      provider: "claude",
      createdAtMs: 123,
      content: new TextEncoder().encode("context"),
      encoding: "identity" as const,
      responseFound: true,
      digestMatch: false,
      triggerFound: true,
      unrestoredMessageCount: 2,
      redactedMediaCount: 1,
      redactedDiagnosticCount: 3,
      viewBytes: 7,
      sourceBytes: 2048,
      verification: "verified" as const,
      failureDetail: undefined,
    };
    expect(decodeAgentContextViewResult(encodeAgentContextViewResult(value))).toEqual(value);
  });

  test("preserves explicit zero observability counts", () => {
    const value = {
      ...request,
      status: "ok" as const,
      createdAtMs: 123,
      content: new TextEncoder().encode("context"),
      encoding: "identity" as const,
      unrestoredMessageCount: 0,
      redactedMediaCount: 0,
      redactedDiagnosticCount: 0,
      viewBytes: 7,
    };
    expect(decodeAgentContextViewResult(encodeAgentContextViewResult(value))).toEqual(value);
  });

  test("rejects mismatched identities and oversized content", () => {
    expect(() => encodeAgentContextViewRequest({ ...request, agentId: "" })).toThrow();
    expect(() =>
      encodeAgentContextViewResult({
        ...request,
        status: "ok",
        createdAtMs: 1,
        content: new Uint8Array(32 * 1024 * 1024 + 1),
        encoding: "identity",
      }),
    ).toThrow();
    expect(() =>
      encodeAgentContextViewResult({
        ...request,
        status: "failed",
        reason: "read_failed",
        createdAtMs: 1,
        content: new Uint8Array(),
        encoding: "identity",
        tooLargeCause: "session_file",
      }),
    ).toThrow();
    expect(() =>
      encodeAgentContextViewResult({
        ...request,
        status: "failed",
        reason: "future_reason" as never,
        createdAtMs: 1,
        content: new Uint8Array(),
        encoding: "identity",
      }),
    ).toThrow();
  });

  test("rejects an unknown failure reason received on the wire", () => {
    const bytes = toBinary(
      AgentContextViewResultSchema,
      create(AgentContextViewResultSchema, {
        ...request,
        messageType: "coforge.rpc.v1.AgentContextViewResult",
        status: "failed",
        reason: "future_reason",
        createdAtMs: 1n,
        content: new Uint8Array(),
        encoding: "identity",
      }),
    );
    expect(() => decodeAgentContextViewResult(bytes)).toThrow("Invalid context view reason");
  });

  test("round trips availability and requires an explicit unsupported reason", () => {
    const value = {
      protocolMajor: 1,
      workspaceId: "workspace-1",
      computerId: "computer-1",
      agentId: "agent-1",
      runtime: "codex",
      retainedSince: new Date(1).toISOString(),
      retentionDays: 30,
      supported: true,
    };
    expect(decodeAgentContextViewAvailability(encodeAgentContextViewAvailability(value))).toEqual(
      value,
    );
    expect(() => encodeAgentContextViewAvailability({ ...value, supported: false })).toThrow();
  });

  test("round trips the server feature availability trigger", () => {
    const value = {
      protocolMajor: 1,
      workspaceId: "workspace-1",
      computerId: "computer-1",
      agentId: "agent-1",
      runtime: "codex",
      retentionDays: 30,
      supported: true,
      trigger: "server_features" as const,
    };
    expect(decodeAgentContextViewAvailability(encodeAgentContextViewAvailability(value))).toEqual(
      value,
    );
  });

  test("round trips the periodic availability trigger", () => {
    const value = {
      protocolMajor: 1,
      workspaceId: "workspace-1",
      computerId: "computer-1",
      agentId: "agent-1",
      runtime: "codex",
      retentionDays: 30,
      supported: true,
      trigger: "periodic" as const,
    };
    expect(decodeAgentContextViewAvailability(encodeAgentContextViewAvailability(value))).toEqual(
      value,
    );
  });

  test("round trips the retention availability trigger", () => {
    const value = {
      protocolMajor: 1,
      workspaceId: "workspace-1",
      computerId: "computer-1",
      agentId: "agent-1",
      runtime: "codex",
      retentionDays: 30,
      supported: true,
      trigger: "retention" as const,
    };
    expect(decodeAgentContextViewAvailability(encodeAgentContextViewAvailability(value))).toEqual(
      value,
    );
  });
});

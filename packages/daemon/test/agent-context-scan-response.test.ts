import { describe, expect, test } from "bun:test";
import { AgentContextReportTimeoutError } from "#src/code-agent/contract";
import {
  agentContextReportOutcome,
  agentContextScanFailure,
  agentContextScanResponse,
} from "#src/daemon-runtime/agent-context-scan-response";
import {
  AGENT_CONTEXT_SCAN_MESSAGE_TYPE,
  type AgentContextReport,
  type AgentContextScanRequest,
} from "@lrm/coforge-sdk/internal";

const request: AgentContextScanRequest = {
  protocolMajor: 1,
  requestId: "req-1",
  workspaceId: "ws-from-request",
  computerId: "computer-from-request",
  agentId: "agent-1",
  provider: "claude-code",
  launchId: "launch-from-request",
  sessionId: "session-from-request",
  messageType: AGENT_CONTEXT_SCAN_MESSAGE_TYPE,
};
const own = { workspaceId: "ws-1", computerId: "computer-1" };
const report = { categories: [] } as unknown as AgentContextReport;

describe("agentContextScanResponse", () => {
  test("answers from this runtime's Workspace and Computer, echoing the correlation fields only", () => {
    // The request's own Workspace, Computer, launch, session and message type are not echoed.
    expect(
      agentContextScanResponse(request, own, {
        launchId: "launch-1",
        sessionId: "session-1",
        status: "no_session",
      }),
    ).toEqual({
      protocolMajor: 1,
      requestId: "req-1",
      workspaceId: "ws-1",
      computerId: "computer-1",
      agentId: "agent-1",
      provider: "claude-code",
      launchId: "launch-1",
      sessionId: "session-1",
      accepted: false,
      status: "no_session",
    });
  });

  test("is accepted exactly when it carries a report, and keeps a message", () => {
    const available = agentContextScanResponse(
      request,
      own,
      agentContextReportOutcome("launch-1", "session-1", report),
    );
    expect(available.accepted).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(available.reportJson))).toEqual(report);
    expect(
      agentContextScanResponse(request, own, {
        launchId: "launch-1",
        sessionId: "session-1",
        status: "error",
        message: "Agent context scan targets a superseded launch",
      }),
    ).toMatchObject({ accepted: false, message: "Agent context scan targets a superseded launch" });
  });
});

describe("agentContextReportOutcome", () => {
  test("a report is available, and no report is unparsed", () => {
    expect(agentContextReportOutcome("l", "s", report).status).toBe("available");
    expect(agentContextReportOutcome("l", "s", undefined)).toEqual({
      launchId: "l",
      sessionId: "s",
      status: "unparsed",
    });
  });
});

describe("agentContextScanFailure", () => {
  test("a timeout is timeout; anything else is a generic error", () => {
    expect(agentContextScanFailure("l", "s", new AgentContextReportTimeoutError())).toEqual({
      launchId: "l",
      sessionId: "s",
      status: "timeout",
    });
    expect(agentContextScanFailure("l", "s", new Error("boom"))).toEqual({
      launchId: "l",
      sessionId: "s",
      status: "error",
      message: "Context scan failed",
    });
  });
});

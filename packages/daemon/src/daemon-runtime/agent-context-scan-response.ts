import { AgentContextReportTimeoutError } from "#src/code-agent/contract";
import {
  AGENT_CONTEXT_SCAN_STATUS,
  type AgentContextReport,
  type AgentContextScanRequest,
  type AgentContextScanResponse,
  type AgentContextScanStatus,
  utf8Encoder,
} from "@lrm/coforge-sdk/internal";

/** What a context scan found, before it is addressed back to the request it answers. */
export type AgentContextScanOutcome = {
  /** The launch and native session the answer names: this runtime's own once it knows them, the
   * request's echoed back until then. */
  launchId: string;
  sessionId: string;
  status: AgentContextScanStatus;
  reportJson?: Uint8Array;
  message?: string;
};

/**
 * The answer to one context scan request, addressed from this runtime's own Workspace and
 * Computer and echoing the request's correlation fields. Accepted exactly when it carries a
 * report.
 */
export function agentContextScanResponse(
  request: AgentContextScanRequest,
  own: { workspaceId: string; computerId: string },
  outcome: AgentContextScanOutcome,
): AgentContextScanResponse {
  return {
    protocolMajor: request.protocolMajor,
    requestId: request.requestId,
    workspaceId: own.workspaceId,
    computerId: own.computerId,
    agentId: request.agentId,
    provider: request.provider,
    launchId: outcome.launchId,
    sessionId: outcome.sessionId,
    accepted: Boolean(outcome.reportJson),
    status: outcome.status,
    ...(outcome.reportJson ? { reportJson: outcome.reportJson } : {}),
    ...(outcome.message ? { message: outcome.message } : {}),
  };
}

/** A report the CLI produced is `available`; a run that produced nothing parseable is
 * `unparsed`. */
export function agentContextReportOutcome(
  launchId: string,
  sessionId: string,
  report: AgentContextReport | undefined,
): AgentContextScanOutcome {
  return report
    ? {
        launchId,
        sessionId,
        status: AGENT_CONTEXT_SCAN_STATUS.AVAILABLE,
        reportJson: utf8Encoder.encode(JSON.stringify(report)),
      }
    : { launchId, sessionId, status: AGENT_CONTEXT_SCAN_STATUS.UNPARSED };
}

/** A run that did not finish in time is `timeout`; any other failure is a generic `error`. */
export function agentContextScanFailure(
  launchId: string,
  sessionId: string,
  error: unknown,
): AgentContextScanOutcome {
  return error instanceof AgentContextReportTimeoutError
    ? { launchId, sessionId, status: AGENT_CONTEXT_SCAN_STATUS.TIMEOUT }
    : {
        launchId,
        sessionId,
        status: AGENT_CONTEXT_SCAN_STATUS.ERROR,
        message: "Context scan failed",
      };
}

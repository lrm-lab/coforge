import { join } from "node:path";
import type {
  AgentContextQueryResponse,
  AgentContextReadRequest,
  AgentContextSearchRequest,
} from "@lrm/coforge-sdk/agent";
import { runContextViewRestoreInChild } from "#src/agent-context-view/context-view-restore-runner";
import { readContextViewSource } from "#src/agent-context-view/context-view-source";
import {
  providerTranscriptRoot,
  resolveProviderTranscriptToken,
} from "#src/agent-context-view/context-view-provider-locator";
import type { AgentContextViewService } from "#src/agent-context-view/agent-context-view-service";
import type { ContextViewIndexEntry } from "#src/agent-context-view/context-view-store";
import { authorizeAgentContextSession } from "#src/agent-context-view/context-view-access";
import { readContextView, searchContextView } from "#src/agent-context-view/context-view-entries";
import { AgentPreflightError } from "./agent-preflight-error";

type Request = AgentContextSearchRequest | AgentContextReadRequest;

export type AgentContextQueryPorts = Readonly<{
  workspaceRoot: string;
  stateDirectory: string;
  contextView: Pick<AgentContextViewService, "find">;
  resolveProviderSource?(agentId: string, entry: ContextViewIndexEntry): string | undefined;
  currentSessionId(agentId: string): string | undefined;
  contextViewEnabled?(agentId: string): boolean | undefined;
}>;

function refuse(message: string, code: string): never {
  throw new AgentPreflightError(message, code, { retryable: false });
}

function sourceFor(ports: AgentContextQueryPorts, agentId: string, entry: ContextViewIndexEntry) {
  const providerPath =
    ports.resolveProviderSource?.(agentId, entry) ??
    resolveProviderTranscriptToken(entry.runtime, entry.transcript);
  const providerRoot = providerPath
    ? providerPath.slice(0, providerPath.lastIndexOf("/"))
    : providerTranscriptRoot(entry.runtime);
  const allowedRoots = [
    ports.workspaceRoot,
    ports.stateDirectory,
    ...(providerRoot ? [providerRoot] : []),
  ];
  const candidates = [
    ...(providerPath ? [providerPath] : []),
    join(ports.workspaceRoot, entry.transcript),
    join(ports.stateDirectory, entry.transcript),
  ];
  const source =
    candidates.map((path) => readContextViewSource(path, allowedRoots)).find((item) => item.ok) ??
    readContextViewSource(candidates[0]!, allowedRoots);
  if (!source.ok) refuse("context source is unavailable", "CONTEXT_SOURCE_UNAVAILABLE");
  return source;
}

/** Own-Agent context query: authorization precedes index lookup and every filesystem operation. */
export async function queryAgentContext(
  ports: AgentContextQueryPorts,
  agentId: string,
  request: Request,
): Promise<AgentContextQueryResponse> {
  const authorization = authorizeAgentContextSession({
    authorizedAgentId: agentId,
    requestedAgentId: agentId,
    requestedSessionId: request.sessionId,
    currentSessionId: ports.currentSessionId(agentId),
  });
  if (!authorization.ok) {
    const code =
      authorization.reason === "agent_mismatch"
        ? "CONTEXT_AGENT_MISMATCH"
        : authorization.reason === "session_unavailable"
          ? "CONTEXT_SESSION_UNAVAILABLE"
          : "CONTEXT_SESSION_MISMATCH";
    refuse("context query is limited to the Agent's current session", code);
  }
  if (ports.contextViewEnabled && ports.contextViewEnabled(agentId) !== true)
    refuse("context view is not enabled for this Agent", "CONTEXT_UNAVAILABLE");

  const entry = ports.contextView.find(agentId, request.messageId);
  if (!entry) refuse("context message was not retained", "CONTEXT_NOT_FOUND");
  if (entry.sessionId !== request.sessionId)
    refuse("context message belongs to another session", "CONTEXT_SESSION_MISMATCH");

  const source = sourceFor(ports, agentId, entry);
  const restored = await runContextViewRestoreInChild({
    runtime: entry.runtime,
    sessionId: entry.sessionId,
    messageId: entry.messageId,
    buffer: source.buffer,
    offset: entry.offset,
    maxBytes: 32 * 1024 * 1024,
  });
  if (ports.currentSessionId(agentId) !== request.sessionId)
    refuse("context session changed while it was being restored", "CONTEXT_SESSION_MISMATCH");
  if (!restored.ok)
    refuse("context could not be restored", `CONTEXT_${restored.failure.toUpperCase()}`);

  try {
    return request.mode === "search"
      ? searchContextView(restored.view, request)
      : readContextView(restored.view, request);
  } catch (error) {
    if (error instanceof AgentPreflightError) throw error;
    refuse(
      error instanceof Error ? error.message : "invalid context query",
      request.mode === "search" ? "CONTEXT_QUERY_INVALID" : "CONTEXT_ENTRY_NOT_FOUND",
    );
  }
}

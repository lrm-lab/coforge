import { join } from "node:path";
import type {
  AgentContextQueryResponse,
  AgentContextReadRequest,
  AgentContextSearchRequest,
} from "@lrm/coforge-sdk/agent";
import {
  runContextViewRestoreFileInChild,
  runContextViewRestoreInChild,
} from "#src/agent-context-view/context-view-restore-runner";
import {
  contextViewSourceMaxBytes,
  openContextViewSourceAsync,
  readContextViewSourceAsync,
  type ContextViewOpenedSourceResult,
  type ContextViewSourceResult,
} from "#src/agent-context-view/context-view-source";
import { ContextViewRestoreCache } from "#src/agent-context-view/context-view-restore-cache";
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
  restoreCache?: ContextViewRestoreCache;
  restoreInChild?: typeof runContextViewRestoreInChild;
}>;

function refuse(message: string, code: string): never {
  throw new AgentPreflightError(message, code, { retryable: false });
}

function sourceCandidates(
  ports: AgentContextQueryPorts,
  agentId: string,
  entry: ContextViewIndexEntry,
) {
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
  return { candidates, allowedRoots };
}

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

  const { candidates, allowedRoots } = sourceCandidates(ports, agentId, entry);
  const maxBytes = 32 * 1024 * 1024;
  const maxSourceBytes = contextViewSourceMaxBytes();
  const cacheKey = (path: string) =>
    JSON.stringify([agentId, entry.sessionId, entry.messageId, entry.offset, maxBytes, path]);
  let openedSource: Extract<ContextViewOpenedSourceResult, { ok: true }> | undefined;
  let bufferedSource: Extract<ContextViewSourceResult, { ok: true }> | undefined;
  let sourcePath: string | undefined;
  let restored: Awaited<ReturnType<typeof runContextViewRestoreInChild>> | undefined;
  for (const path of candidates) {
    const cached = ports.restoreCache?.get({ key: cacheKey(path), path, allowedRoots });
    if (cached) {
      restored = cached.restored;
      break;
    }
    if (ports.restoreInChild) {
      const candidate = await readContextViewSourceAsync(path, allowedRoots, maxSourceBytes);
      if (candidate.ok) {
        sourcePath = path;
        bufferedSource = candidate;
        break;
      }
    } else {
      const candidate = await openContextViewSourceAsync(path, allowedRoots, maxSourceBytes);
      if (candidate.ok) {
        sourcePath = path;
        openedSource = candidate;
        break;
      }
    }
  }
  if (!restored) {
    let sourceBytes: number;
    if (ports.restoreInChild) {
      if (!bufferedSource) refuse("context source is unavailable", "CONTEXT_SOURCE_UNAVAILABLE");
      sourceBytes = bufferedSource.sourceBytes;
      restored = await ports.restoreInChild({
        runtime: entry.runtime,
        sessionId: entry.sessionId,
        messageId: entry.messageId,
        buffer: bufferedSource.buffer,
        offset: entry.offset,
        maxBytes,
      });
    } else {
      if (!openedSource) refuse("context source is unavailable", "CONTEXT_SOURCE_UNAVAILABLE");
      const streamed = await runContextViewRestoreFileInChild({
        runtime: entry.runtime,
        sessionId: entry.sessionId,
        messageId: entry.messageId,
        handle: openedSource.handle,
        offset: entry.offset,
        maxBytes,
        maxSourceBytes,
      });
      restored = streamed.result;
      sourceBytes = streamed.sourceBytes;
    }
    if (sourcePath && ports.restoreCache)
      ports.restoreCache.set(
        { key: cacheKey(sourcePath), path: sourcePath, allowedRoots },
        sourceBytes,
        restored,
      );
  }
  if (ports.currentSessionId(agentId) !== request.sessionId)
    refuse("context session changed while it was being restored", "CONTEXT_SESSION_MISMATCH");
  if (!restored.ok)
    refuse(
      restored.detail === undefined
        ? "context could not be restored"
        : `context could not be restored: ${restored.detail}`,
      `CONTEXT_${restored.failure.toUpperCase()}`,
    );

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

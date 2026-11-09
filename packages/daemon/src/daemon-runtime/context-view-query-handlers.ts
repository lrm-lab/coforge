import { join } from "node:path";
import type { AgentContextViewRequest, AgentContextViewResult } from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { readContextViewSource } from "#src/agent-context-view/context-view-source";
import {
  providerTranscriptRoot,
  resolveProviderTranscriptToken,
} from "#src/agent-context-view/context-view-provider-locator";
import { runContextViewRestoreInChild } from "#src/agent-context-view/context-view-restore-runner";
import type { AgentContextViewService } from "#src/agent-context-view/agent-context-view-service";
import type { ContextViewIndexEntry } from "#src/agent-context-view/context-view-store";
import type { DaemonConfig } from "./runtime";
import { getLogger } from "@logtape/logtape";

const MAX_RESULT_BYTES = 32 * 1024 * 1024;
const logger = getLogger(["coforge", "daemon", "context-view"]);

type Ports = {
  connection: DaemonConfig;
  stateDirectory: string;
  contextView: Pick<AgentContextViewService, "lookup">;
  resolveProviderSource?(agentId: string, entry: ContextViewIndexEntry): string | undefined;
  agentApiKey?(agentId: string): string | undefined;
  currentTransport(): DaemonConnectionClient;
  isStopping(): boolean;
};

function failure(
  request: AgentContextViewRequest,
  reason: AgentContextViewResult["reason"],
  detail?: string,
): AgentContextViewResult {
  return {
    ...request,
    status: "failed",
    reason,
    failureDetail: detail,
    createdAtMs: Date.now(),
    content: new Uint8Array(),
    encoding: "identity",
  };
}

async function sendResult(
  transport: DaemonConnectionClient,
  result: AgentContextViewResult,
  agentApiKey?: string,
): Promise<void> {
  try {
    if (!agentApiKey) throw new Error("context view Agent API key unavailable");
    if (transport.postAgentContextViewResult) {
      await transport.postAgentContextViewResult(result, agentApiKey);
      return;
    }
    throw new Error("context view HTTP result upload is unavailable");
  } catch (error) {
    logger.warning("Context view result upload failed", {
      event: "context_view:result_upload_failed",
      request_id: result.requestId,
      error_code: error instanceof Error ? error.name : "unknown",
    });
    // The request has already been logged; no local state is mutated by a failed upload.
  }
}

export function subscribeContextViewQueries(
  transport: DaemonConnectionClient,
  ports: Ports,
): (() => void) | undefined {
  let requestChain = Promise.resolve();
  const queued = (request: AgentContextViewRequest): Promise<void> => {
    const receivedAt = Date.now();
    const run = requestChain.then(async () => {
      // Leave the final five seconds of Raft's 30 second viewer window for upload and polling.
      if (Date.now() - receivedAt >= 23_000) return;
      await answer(request);
    });
    requestChain = run.catch(() => undefined);
    return run;
  };
  const answer = async (request: AgentContextViewRequest) => {
    const startedAt = Date.now();
    if (
      ports.isStopping() ||
      request.workspaceId !== ports.connection.workspaceId ||
      request.computerId !== ports.connection.computerId
    )
      return;
    const lookup = ports.contextView.lookup(request.agentId, request.messageId);
    if (lookup.status !== "found") {
      const reason =
        lookup.status === "expired"
          ? "expired"
          : lookup.status === "not_recorded"
            ? "not_recorded"
            : "not_found";
      logger.info("Context view request unavailable", {
        event: "context_view:request",
        request_id: request.requestId,
        agent_id: request.agentId,
        failure: reason,
      });
      await sendResult(
        transport,
        failure(request, reason),
        ports.agentApiKey?.(request.agentId),
      );
      return;
    }
    const entry = lookup.entry;
    if (entry.sessionId !== request.sessionId) {
      logger.info("Context view request rejected", {
        event: "context_view:request",
        request_id: request.requestId,
        agent_id: request.agentId,
        failure: "context_mismatch",
      });
      await sendResult(
        transport,
        failure(request, "context_mismatch"),
        ports.agentApiKey?.(request.agentId),
      );
      return;
    }
    const providerPath =
      ports.resolveProviderSource?.(request.agentId, entry) ??
      resolveProviderTranscriptToken(entry.runtime, entry.transcript);
    const providerRoot = providerPath
      ? providerPath.slice(0, providerPath.lastIndexOf("/"))
      : providerTranscriptRoot(entry.runtime);
    const allowedRoots = [
      ports.connection.workspaceRoot,
      ports.stateDirectory,
      ...(providerRoot ? [providerRoot] : []),
    ];
    const sourcePathCandidates = [
      ...(providerPath ? [providerPath] : []),
      join(ports.connection.workspaceRoot, entry.transcript),
      join(ports.stateDirectory, entry.transcript),
    ];
    const source =
      sourcePathCandidates
        .map((path) => readContextViewSource(path, allowedRoots))
        .find((candidate) => candidate.ok) ??
      readContextViewSource(sourcePathCandidates[0]!, allowedRoots);
    if (!source.ok) {
      const reason =
        source.failure === "too_large"
          ? "too_large"
          : source.failure === "missing"
            ? "not_found"
            : "read_failed";
      await sendResult(
        transport,
        failure(request, reason, source.failure),
        ports.agentApiKey?.(request.agentId),
      );
      return;
    }
    const restored = await runContextViewRestoreInChild({
      runtime: entry.runtime,
      sessionId: entry.sessionId,
      messageId: entry.messageId,
      buffer: source.buffer,
      offset: entry.offset,
      maxBytes: Math.min(MAX_RESULT_BYTES, request.maxBytes),
    });
    const restoreFinishedAt = Date.now();
    const result = restored.ok
      ? (() => {
          const content = new TextEncoder().encode(JSON.stringify(restored.view));
          return content.byteLength > Math.min(MAX_RESULT_BYTES, request.maxBytes)
            ? failure(request, "too_large")
            : {
                ...request,
                status: "ok" as const,
                provider: entry.runtime,
                createdAtMs: Date.now(),
                content,
                encoding: "identity" as const,
                responseFound: restored.view.responseFound,
                digestMatch: restored.view.digestMatch ?? undefined,
                triggerFound: restored.view.trigger !== undefined,
                unrestoredMessageCount: restored.view.unrestoredMessages,
                redactedMediaCount: restored.view.redactions.media,
                redactedDiagnosticCount: restored.view.redactions.diagnostic,
                viewBytes: content.byteLength,
              };
        })()
      : failure(request, restored.failure, restored.failure);
    logger.info("Context view request finished", {
      event: "context_view:result",
      request_id: request.requestId,
      agent_id: request.agentId,
      runtime: entry.runtime,
      status: result.status,
      failure: result.reason,
      source_bytes: source.sourceBytes,
      source: providerPath ? "provider" : "workspace_or_state_fallback",
      index_or_fallback: entry.transcript,
      response_found: restored.ok ? restored.view.responseFound === true : false,
      digest_match: restored.ok ? restored.view.digestMatch === true : false,
      redacted_media: restored.ok ? restored.view.redactions.media : 0,
      redacted_diagnostic: restored.ok ? restored.view.redactions.diagnostic : 0,
      view_bytes: result.status === "ok" ? result.content.byteLength : 0,
      message_count: restored.ok ? restored.view.messages.length : 0,
      unrestored_message_count: restored.ok ? (restored.view.unrestoredMessages ?? 0) : 0,
      trigger_found: restored.ok ? restored.view.trigger !== undefined : false,
      failure_detail: restored.ok ? undefined : restored.failure,
      restore_duration_ms: restoreFinishedAt - startedAt,
      duration_ms: Date.now() - startedAt,
    });
    if (!ports.isStopping() && ports.currentTransport() === transport)
      await sendResult(transport, result, ports.agentApiKey?.(request.agentId));
  };
  return transport.onAgentContextView?.(queued);
}

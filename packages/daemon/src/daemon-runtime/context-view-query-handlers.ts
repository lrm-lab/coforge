import { join } from "node:path";
import {
  encodeAgentContextViewResult,
  type AgentContextViewRequest,
  type AgentContextViewResult,
} from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import {
  contextViewSourceMaxBytes,
  openContextViewSourceAsync,
  readContextViewSourceAsync,
  type ContextViewOpenedSourceResult,
  type ContextViewSourceFailure,
  type ContextViewSourceResult,
} from "#src/agent-context-view/context-view-source";
import { ContextViewRestoreCache } from "#src/agent-context-view/context-view-restore-cache";
import {
  providerTranscriptRoot,
  resolveProviderTranscriptToken,
} from "#src/agent-context-view/context-view-provider-locator";
import {
  runContextViewRestoreFileInChild,
  runContextViewRestoreInChild,
} from "#src/agent-context-view/context-view-restore-runner";
import type { AgentContextViewService } from "#src/agent-context-view/agent-context-view-service";
import type { ContextViewIndexEntry } from "#src/agent-context-view/context-view-store";
import type { DaemonConfig } from "./runtime";
import type { AgentContextViewUploadError } from "#src/connection/agent-context-view-upload";
import { getLogger } from "@logtape/logtape";
import type { ContextViewRestoreResult } from "#src/agent-context-view/context-view-restore";

const MAX_RESULT_BYTES = 32 * 1024 * 1024;
export const CONTEXT_VIEW_QUEUE_DEADLINE_MS = 23_000;
const logger = getLogger(["coforge", "daemon", "context-view"]);

type Ports = {
  connection: DaemonConfig;
  stateDirectory: string;
  contextView: Pick<AgentContextViewService, "find">;
  resolveProviderSource?(agentId: string, entry: ContextViewIndexEntry): string | undefined;
  agentApiKey?(agentId: string): string | undefined;
  currentTransport(): DaemonConnectionClient;
  isStopping(): boolean;
  restoreInChild?: typeof runContextViewRestoreInChild;
};

function failure(
  request: AgentContextViewRequest,
  reason: AgentContextViewResult["reason"],
  detail?: string,
  metadata: Pick<AgentContextViewResult, "sourceBytes" | "tooLargeCause"> = {},
): AgentContextViewResult {
  return {
    ...request,
    status: "failed",
    reason,
    failureDetail: detail,
    createdAtMs: Date.now(),
    content: new Uint8Array(),
    encoding: "identity",
    ...metadata,
  };
}

async function sendResult(
  transport: DaemonConnectionClient,
  result: AgentContextViewResult,
  agentApiKey?: string,
): Promise<Record<string, unknown>> {
  try {
    if (!agentApiKey) throw new Error("context view Agent API key unavailable");
    if (transport.postAgentContextViewResult) {
      const upload = await transport.postAgentContextViewResult(result, agentApiKey);
      return {
        post_outcome: "accepted",
        posted_bytes: upload?.postedBytes ?? encodeAgentContextViewResult(result).byteLength,
        ...(upload?.compressedBytes === undefined
          ? {}
          : { compressed_bytes: upload.compressedBytes }),
        ...(upload?.httpStatus === undefined ? {} : { http_status: upload.httpStatus }),
      };
    }
    throw new Error("context view HTTP result upload is unavailable");
  } catch (error) {
    const uploadError = error as AgentContextViewUploadError;
    logger.warning("Context view result upload failed", {
      event: "context_view:result_upload_failed",
      request_id: result.requestId,
      error_code: error instanceof Error ? error.name : "unknown",
    });
    return {
      post_outcome: "failed",
      posted_bytes: uploadError.postedBytes ?? encodeAgentContextViewResult(result).byteLength,
      ...(uploadError.compressedBytes === undefined
        ? {}
        : { compressed_bytes: uploadError.compressedBytes }),
      ...(uploadError.httpStatus === undefined
        ? { error_class: error instanceof Error ? error.name : "unknown" }
        : { http_status: uploadError.httpStatus }),
    };
  }
}

function logRequestTrace(
  request: AgentContextViewRequest,
  startedAt: number,
  fields: Record<string, unknown>,
): void {
  logger.info("Context view request finished", {
    event: "context_view:result",
    request_id: request.requestId,
    agent_id: request.agentId,
    outcome: fields.outcome,
    failure_detail: fields.failure_detail,
    duration_ms: Math.max(0, Date.now() - startedAt),
    ...fields,
  });
}

export function subscribeContextViewQueries(
  transport: DaemonConnectionClient,
  ports: Ports,
): (() => void) | undefined {
  const chains = new Map<string, Promise<void>>();
  const restoreCache = new ContextViewRestoreCache();
  let unsubscribed = false;
  const queued = (request: AgentContextViewRequest): Promise<void> => {
    const receivedAt = Date.now();
    const run = (chains.get(request.agentId) ?? Promise.resolve()).then(async () => {
      const queuedMs = Math.max(0, Date.now() - receivedAt);
      if (queuedMs >= CONTEXT_VIEW_QUEUE_DEADLINE_MS) {
        logger.error("Context view request expired", {
          event: "daemon.agent_context_view.request_expired",
          agent_id: request.agentId,
          queued_ms: queuedMs,
        });
        const expired = failure(request, "expired", "queue_deadline");
        const postTrace = await sendResult(
          transport,
          expired,
          ports.agentApiKey?.(request.agentId),
        );
        logRequestTrace(request, receivedAt, {
          outcome: expired.status,
          failure_detail: expired.failureDetail,
          queued_ms: queuedMs,
          ...postTrace,
          status: expired.status,
          reason: expired.reason,
          failure: expired.reason,
        });
        return;
      }
      try {
        await answer(request, receivedAt);
      } catch (error) {
        const result = failure(request, "read_failed", "exception");
        const postTrace = await sendResult(transport, result, ports.agentApiKey?.(request.agentId));
        logRequestTrace(request, receivedAt, {
          outcome: result.status,
          failure_detail: result.failureDetail,
          error_class: error instanceof Error ? error.name : "unknown",
          queued_ms: Math.max(0, Date.now() - receivedAt),
          ...postTrace,
          status: result.status,
          reason: result.reason,
          failure: result.reason,
        });
      }
    });
    const settled = run.catch(() => undefined);
    chains.set(request.agentId, settled);
    void settled.then(() => {
      if (chains.get(request.agentId) === settled) chains.delete(request.agentId);
    });
    return run;
  };
  const answer = async (request: AgentContextViewRequest, receivedAt: number) => {
    const startedAt = Date.now();
    if (ports.isStopping()) {
      logRequestTrace(request, startedAt, {
        outcome: "rejected",
        failure_detail: "daemon_stopping",
        post_outcome: "skipped",
        queued_ms: Math.max(0, startedAt - receivedAt),
      });
      return;
    }
    if (
      request.workspaceId !== ports.connection.workspaceId ||
      request.computerId !== ports.connection.computerId
    ) {
      logRequestTrace(request, startedAt, {
        outcome: "rejected",
        failure_detail: "scope_mismatch",
        post_outcome: "skipped",
        queued_ms: Math.max(0, startedAt - receivedAt),
      });
      return;
    }
    const finish = async (
      result: AgentContextViewResult,
      fields: Record<string, unknown> = {},
    ): Promise<void> => {
      const postTrace = await sendResult(transport, result, ports.agentApiKey?.(request.agentId));
      logRequestTrace(request, startedAt, {
        ...fields,
        queued_ms: Math.max(0, startedAt - receivedAt),
        outcome: result.status,
        failure_detail: result.failureDetail ?? result.reason,
        ...postTrace,
        status: result.status,
        reason: result.reason,
        failure: result.reason,
        source_bytes: result.sourceBytes,
        view_bytes: result.viewBytes,
      });
    };
    const entry = ports.contextView.find(request.agentId, request.messageId);
    if (!entry) {
      logger.info("Context view request unavailable", {
        event: "context_view:request",
        request_id: request.requestId,
        agent_id: request.agentId,
        failure: "not_found",
      });
      await finish(failure(request, "not_found"));
      return;
    }
    if (entry.sessionId !== request.sessionId) {
      logger.info("Context view request rejected", {
        event: "context_view:request",
        request_id: request.requestId,
        agent_id: request.agentId,
        failure: "context_mismatch",
      });
      await finish(failure(request, "context_mismatch"));
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
    const maxBytes = Math.min(MAX_RESULT_BYTES, request.maxBytes);
    const maxSourceBytes = contextViewSourceMaxBytes();
    const cacheKey = (path: string) =>
      JSON.stringify([
        request.agentId,
        entry.sessionId,
        entry.messageId,
        entry.offset,
        maxBytes,
        path,
      ]);
    let sourcePath: string | undefined;
    let openedSource: Extract<ContextViewOpenedSourceResult, { ok: true }> | undefined;
    let bufferedSource: Extract<ContextViewSourceResult, { ok: true }> | undefined;
    let firstFailure: ContextViewSourceFailure | undefined;
    let sourceBytes: number | undefined;
    let restored: ContextViewRestoreResult | undefined;
    for (const path of sourcePathCandidates) {
      const cached = restoreCache.get({ key: cacheKey(path), path, allowedRoots });
      if (cached) {
        sourcePath = path;
        sourceBytes = cached.sourceBytes;
        restored = cached.restored;
        break;
      }
      if (ports.restoreInChild) {
        const candidate = await readContextViewSourceAsync(path, allowedRoots, maxSourceBytes);
        if (candidate.ok) {
          sourcePath = path;
          bufferedSource = candidate;
          sourceBytes = candidate.sourceBytes;
          break;
        }
        firstFailure ??= candidate.failure;
      } else {
        const candidate = await openContextViewSourceAsync(path, allowedRoots, maxSourceBytes);
        if (candidate.ok) {
          sourcePath = path;
          openedSource = candidate;
          sourceBytes = candidate.size;
          break;
        }
        firstFailure ??= candidate.failure;
      }
    }
    if (!restored) {
      if (!bufferedSource && !openedSource) {
        const failureKind = firstFailure ?? "read_failed";
        const reason =
          failureKind === "too_large"
            ? "too_large"
            : failureKind === "missing"
              ? "not_found"
              : "read_failed";
        const result =
          reason === "too_large"
            ? failure(request, reason, failureKind, { tooLargeCause: "session_file" })
            : failure(request, reason, failureKind);
        await finish(result, {
          runtime: entry.runtime,
          source: providerPath ? "provider" : "workspace_or_state_fallback",
          index_or_fallback: entry.transcript,
        });
        return;
      }
      if (ports.restoreInChild) {
        sourceBytes = bufferedSource!.sourceBytes;
        restored = await ports.restoreInChild({
          runtime: entry.runtime,
          sessionId: entry.sessionId,
          messageId: entry.messageId,
          buffer: bufferedSource!.buffer,
          offset: entry.offset,
          maxBytes,
        });
      } else {
        const streamed = await runContextViewRestoreFileInChild({
          runtime: entry.runtime,
          sessionId: entry.sessionId,
          messageId: entry.messageId,
          handle: openedSource!.handle,
          offset: entry.offset,
          maxBytes,
          maxSourceBytes,
        });
        restored = streamed.result;
        sourceBytes = streamed.sourceBytes;
      }
      if (!unsubscribed && sourcePath)
        restoreCache.set(
          { key: cacheKey(sourcePath), path: sourcePath, allowedRoots },
          sourceBytes,
          restored,
        );
    }
    const restoreFinishedAt = Date.now();
    const result = restored.ok
      ? (() => {
          const content = new TextEncoder().encode(JSON.stringify(restored.view));
          return content.byteLength > maxBytes
            ? failure(request, "too_large", "view_over_max_bytes", {
                sourceBytes,
                tooLargeCause: "request",
              })
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
                sourceBytes,
                verification: restored.view.verification,
              };
        })()
      : failure(request, restored.failure, restored.detail ?? restored.failure, {
          sourceBytes,
          ...(restored.failure === "too_large" && restored.tooLargeCause
            ? { tooLargeCause: restored.tooLargeCause }
            : {}),
        });
    const fields = {
      runtime: entry.runtime,
      source: providerPath ? "provider" : "workspace_or_state_fallback",
      index_or_fallback: entry.transcript,
      response_found: restored.ok ? restored.view.responseFound === true : false,
      digest_match: restored.ok ? restored.view.digestMatch === true : false,
      redacted_media: restored.ok ? restored.view.redactions.media : 0,
      redacted_diagnostic: restored.ok ? restored.view.redactions.diagnostic : 0,
      verification: restored.ok ? restored.view.verification : undefined,
      message_count: restored.ok ? restored.view.messages.length : 0,
      unrestored_message_count: restored.ok ? (restored.view.unrestoredMessages ?? 0) : 0,
      trigger_found: restored.ok ? restored.view.trigger !== undefined : false,
      restore_duration_ms: restoreFinishedAt - startedAt,
    };
    if (!ports.isStopping() && ports.currentTransport() === transport) await finish(result, fields);
    else
      logRequestTrace(request, startedAt, {
        ...fields,
        queued_ms: Math.max(0, startedAt - receivedAt),
        outcome: result.status,
        failure_detail: result.failureDetail ?? result.reason,
        post_outcome: "skipped",
        posted_bytes: encodeAgentContextViewResult(result).byteLength,
        status: result.status,
        reason: result.reason,
        failure: result.reason,
        source_bytes: result.sourceBytes,
        view_bytes: result.viewBytes,
      });
  };
  const unsubscribe = transport.onAgentContextView?.(queued);
  if (!unsubscribe) return undefined;
  return () => {
    unsubscribed = true;
    restoreCache.clear();
    unsubscribe();
  };
}

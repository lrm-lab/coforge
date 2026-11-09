/** The deliberately small boundary between Centrifugo's HTTP proxy and Web. */
import { utf8Encoder } from "@lrm/coforge-sdk/internal";
import { handleRequestError } from "#src/server/errors/request-error-handler.server";
import { requireDaemonPrincipal } from "./daemon-rpc-principal.server";
import { validModelCatalogs } from "./rpc-handler-catalog-validation.server";
import { WorkspaceQueryError, WorkspaceQueryUseCase } from "#src/server/workspaces/query.server";
import { decodeWorkspaceGetRequest, decodeWorkspaceListRequest } from "@lrm/coforge-sdk/internal";
import {
  decodeAgentStartIntent,
  decodeAgentStatus,
  decodeDaemonRuntimeCodeAgentsUpdateRequest,
  decodeDaemonRuntimeUsageScanResponse,
  type CodeAgentModelCatalog,
  type RuntimeMetadata,
} from "@lrm/coforge-sdk/internal";
import { getUsageCache, type UsageCache } from "./usage-cache.server";
import { decodeUsageSnapshot } from "./usage-snapshot-decode.server";
import { PublishAgentRuntimeControl } from "#src/server/agents/agent-runtime-control.server";
import {
  AgentDeliveryRejectionScopeError,
  type AgentDeliveryRejectionOutcome,
} from "#src/server/agents/agent-delivery-rejection.server";
import { rejectNonDaemonPrincipal } from "./daemon-principal.server";
import {
  decodeAgentMessageDeliveryAck,
  decodeAgentMessageDeliveryRejection,
  type AgentMessageDeliveryRejection,
} from "@lrm/coforge-sdk/internal";
import {
  AGENT_STATUS_LEASE_MS,
  getAgentStatusCache,
  type AgentStatusCache,
} from "#src/server/agents/agent-status.server";
import {
  agentStatusChannel,
  agentStatusChannelForAgent,
  encodeAgentStatusEvent,
  publishAgentDisplay,
} from "#src/features/agents/agent-status-channel";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import type { CentrifugoServerApi } from "./server-api.server";
import type { AgentDisplay } from "#src/server/agents/agent-display.server";
import { decodeDaemonRuntimeShutdown, type DaemonRuntimeShutdown } from "@lrm/coforge-sdk/internal";
import type { ComputerLifecycleActivity } from "#src/server/agents/computer-lifecycle-activity.server";
import type { MentionDeliveryEnvelope } from "@lrm/coforge-sdk/internal";
import { errorType } from "#src/server/errors/error-type.server";
export {
  createAgentSessionMethod,
  createAgentSessionInvalidateMethod,
} from "./agent-session-receiver.server";
export {
  createMentionDeliveryTransitionMethod,
  createMentionDeliveryTerminalErrorMethod,
} from "./mention-delivery-receiver.server";

export {
  createAgentReminderMethod,
  createReminderFireMethod,
  createReminderSnapshotMethod,
  createAppConfigSnapshotMethod,
} from "./daemon-owned-rpc-methods.server";

/** Records a daemon's delivery ACK through `acks`; `MentionDeliveryReports` also settles the
 * tracked mention it answers. */
export function createAgentDeliveryAckMethod(acks: {
  receiveDeliveryAck(input: {
    workspaceId: string;
    computerId: string;
    agentId: string;
    deliveryId: string;
    messageId: string;
    sequence: number;
    mentionDelivery?: MentionDeliveryEnvelope;
  }): Promise<void>;
}): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    const ack = decodeAgentMessageDeliveryAck(payload);
    if (
      !metadata.principal.userId ||
      !metadata.principal.computerId ||
      metadata.principal.workspaceId !== ack.workspaceId
    )
      return { code: 403, message: "workspace scope is not authorized" };
    try {
      await acks.receiveDeliveryAck({
        ...ack,
        computerId: metadata.principal.computerId,
      });
      return new Uint8Array();
    } catch {
      return {
        code: 403,
        message: "delivery acknowledgement is not authorized",
      };
    }
  };
}

/** A delivery the Daemon rejected instead of taking custody of it. Scoped to the authenticated
 * Computer; `AgentDeliveryRejections` decides what the server does about it. */
export function createAgentDeliveryRejectMethod(rejections: {
  receive(
    scope: { workspaceId: string; computerId: string },
    rejection: AgentMessageDeliveryRejection,
  ): Promise<AgentDeliveryRejectionOutcome>;
}): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    const denied = rejectNonDaemonPrincipal(metadata.principal);
    if (denied) return denied;
    let rejection: AgentMessageDeliveryRejection;
    try {
      rejection = decodeAgentMessageDeliveryRejection(payload);
    } catch {
      return { code: 400, message: "invalid Agent delivery rejection" };
    }
    const { workspaceId, computerId } = metadata.principal;
    if (workspaceId !== rejection.workspaceId)
      return { code: 403, message: "delivery rejection is not authorized" };
    try {
      await rejections.receive({ workspaceId, computerId }, rejection);
      return new Uint8Array();
    } catch (error) {
      if (!(error instanceof AgentDeliveryRejectionScopeError)) throw error;
      return { code: 403, message: error.message };
    }
  };
}

export function createAgentStartMethod(useCase: PublishAgentRuntimeControl): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    if (!metadata.principal.userId) return { code: 401, message: "authentication required" };
    try {
      await useCase.start(decodeAgentStartIntent(payload), metadata.principal.userId);
      return new Uint8Array();
    } catch (error) {
      return {
        code: 403,
        message: error instanceof Error ? error.message : "agent start rejected",
      };
    }
  };
}

export function createAgentStatusMethod(
  agents: {
    getById(
      id: string,
    ): Promise<{ workspaceId: string; computerId?: string; visibility?: string } | undefined>;
  },
  statuses?: AgentStatusCache,
  events?: Pick<CentrifugoServerApi, "publish">,
  now = Date.now,
  display?: Pick<AgentDisplay, "observeStatus">,
  displayEvents?: Pick<CentrifugoServerApi, "publishJson">,
): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    const status = decodeAgentStatus(payload);
    const agent = await agents.getById(status.agentId);
    if (
      !metadata.principal.userId ||
      metadata.principal.workspaceId !== status.workspaceId ||
      metadata.principal.computerId !== status.computerId ||
      agent?.workspaceId !== status.workspaceId ||
      agent.computerId !== status.computerId
    )
      return { code: 403, message: "Agent status is not authorized" };
    const accepted = await (statuses ?? getAgentStatusCache()).put(status);
    if (!accepted) return new Uint8Array();
    // Persist the display process lease before optional realtime fan-out. A
    // Centrifugo publish failure must not leave an accepted status fact offline.
    let snapshot: Awaited<ReturnType<NonNullable<typeof display>["observeStatus"]>> | undefined;
    if (display) {
      try {
        snapshot = await display.observeStatus(status);
      } catch {
        // The optional display read model cannot reject an accepted process fact.
      }
    }
    // Folded into the Agent row already fetched above for authorization — no extra
    // query, and never optional in effect: `visibility === undefined` (the lookup found nothing
    // to route by; never happens once the authorization check above passed for a real Agent row)
    // skips fan-out entirely — fails closed — rather than guessing the shared channel. The
    // process lease above is still accepted independently of this decision.
    const visibility = agent.visibility;
    const isPrivate = visibility !== undefined && visibility !== AGENT_VISIBILITY.PUBLIC;
    const channel = isPrivate
      ? agentStatusChannelForAgent(status.workspaceId, status.agentId)
      : agentStatusChannel(status.workspaceId);
    try {
      if (visibility === undefined) return new Uint8Array();
      if (events) {
        await events.publish(
          channel,
          encodeAgentStatusEvent({
            agentId: status.agentId,
            status: status.status,
            expiresAt: status.status === "active" ? now() + AGENT_STATUS_LEASE_MS : null,
            daemonInstanceId: status.daemonInstanceId,
            clientSeq: status.clientSeq,
            observedAtMs: status.observedAtMs,
          }),
        );
      }
      if (snapshot && displayEvents)
        await publishAgentDisplay(displayEvents.publishJson, channel, snapshot, isPrivate);
    } catch {
      // Realtime fan-out is best-effort once the process lease is stored.
    }
    return new Uint8Array();
  };
}

export {
  createDaemonRuntimeReadyMethod,
  type DaemonRuntimeReadyPorts,
} from "./daemon-runtime-ready-method.server";

/**
 * A Workspace daemon's notice that it is going down on purpose, and why. Refusals answer like a
 * ready does: 400 for a malformed notice, 403 for another Computer's, 409 for one from a daemon a
 * newer ready already replaced. Each is logged with its stable reason.
 */
export function createDaemonRuntimeShutdownMethod(
  lifecycle: Pick<ComputerLifecycleActivity, "shutdown">,
  currentWorkerInstanceId?: (scope: {
    workspaceId: string;
    computerId: string;
  }) => Promise<string | undefined>,
): CentrifugoRpcMethod {
  const refuse = (
    error: CentrifugoRpcError,
    reason: "malformed" | "foreign_computer" | "superseded",
    notice?: DaemonRuntimeShutdown,
  ) => {
    console.warn(
      JSON.stringify({
        event: "daemon_shutdown.rejected",
        outcome: "rejected",
        reason,
        ...(notice
          ? {
              request_id: notice.requestId,
              workspace_id: notice.workspaceId,
              computer_id: notice.computerId,
            }
          : {}),
      }),
    );
    return error;
  };
  return async (payload, metadata) => {
    let notice: DaemonRuntimeShutdown;
    try {
      notice = decodeDaemonRuntimeShutdown(payload);
    } catch {
      return refuse({ code: 400, message: "invalid daemon shutdown notice" }, "malformed");
    }
    const denied = requireDaemonPrincipal(metadata, notice);
    if (denied) return refuse(denied, "foreign_computer", notice);
    const scope = { workspaceId: notice.workspaceId, computerId: notice.computerId };
    try {
      const current = await currentWorkerInstanceId?.(scope);
      if (current && current !== notice.workerInstanceId)
        return refuse(
          { code: 409, message: "daemon runtime was superseded" },
          "superseded",
          notice,
        );
      await lifecycle.shutdown(scope, { requestId: notice.requestId, reason: notice.reason });
      return new Uint8Array();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "daemon_shutdown.record_failed",
          outcome: "failed",
          request_id: notice.requestId,
          workspace_id: notice.workspaceId,
          computer_id: notice.computerId,
          error_type: errorType(error),
        }),
      );
      return { code: 503, message: "daemon shutdown notice was not recorded" };
    }
  };
}

export { createDaemonConnectionStatusMethod } from "./daemon-connection-status-method.server";

export function createDaemonRuntimeCodeAgentsUpdateMethod(inventory: {
  replace(
    scope: { workspaceId: string; computerId: string },
    runtimes: RuntimeMetadata[],
    catalogs: CodeAgentModelCatalog[],
  ): Promise<unknown>;
}): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    const request = decodeDaemonRuntimeCodeAgentsUpdateRequest(payload);
    const denied = requireDaemonPrincipal(metadata, request);
    if (denied) return denied;
    if (
      request.protocolMajor !== 1 ||
      !request.requestId ||
      (request.runtimes ?? []).some((runtime) => !runtime.version.trim()) ||
      !validModelCatalogs(request.catalogs)
    )
      return { code: 400, message: "invalid Code Agent inventory" };
    try {
      await inventory.replace(
        { workspaceId: request.workspaceId, computerId: request.computerId },
        request.runtimes ?? [],
        request.catalogs,
      );
      return new Uint8Array();
    } catch {
      return { code: 503, message: "Code Agent inventory update failed" };
    }
  };
}

export function createDaemonRuntimeUsageScanResultMethod(
  usageCache?: Pick<UsageCache, "putResult" | "releaseScan">,
): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    const response = decodeDaemonRuntimeUsageScanResponse(payload);
    const denied = requireDaemonPrincipal(metadata, response);
    if (denied) return denied;
    if (response.protocolMajor !== 1 || !response.requestId || !response.provider)
      return { code: 400, message: "invalid usage scan result" };
    const snapshot = response.snapshotJson
      ? decodeUsageSnapshot(response.snapshotJson, response.provider)
      : undefined;
    const cache = usageCache ?? getUsageCache();
    if (response.snapshotJson && !snapshot) {
      // The scan is over though its reading is refused: end it, or a Refresh would join it and
      // wait for a result that is not coming.
      await cache.releaseScan(response, response.requestId).catch(() => undefined);
      return { code: 400, message: "invalid usage scan result" };
    }
    await cache.putResult({
      workspaceId: response.workspaceId,
      computerId: response.computerId,
      provider: response.provider,
      scanId: response.requestId,
      status: usageStatus(response.status),
      message: response.message,
      snapshot,
      // The snapshot's own observation time when the Computer reported one, otherwise this
      // result is only as fresh as the moment the server received it.
      collectedAt: snapshot?.collectedAt ?? new Date().toISOString(),
    });
    return new Uint8Array();
  };
}

export { createDaemonRuntimeProviderModelRefreshResultMethod } from "./model-refresh-result-method.server";

function usageStatus(
  value: string,
): "available" | "unavailable" | "reauth" | "unsupported" | "error" {
  if (value === "available") return "available";
  if (value === "unavailable" || value === "reauth" || value === "unsupported" || value === "error")
    return value;
  return "error";
}

/** The signed-in user an RPC acts for, when its principal names one. */
function userPrincipal({ principal }: CentrifugoRpcMetadata) {
  return principal.userId
    ? {
        userId: principal.userId,
        // An attach token's bound workspace and the session it is consumed against pass through
        // (task #417); a daemon principal's empty-string workspaceId means none.
        workspaceId: principal.workspaceId || undefined,
        attachSessionId: principal.attachSessionId,
      }
    : undefined;
}

/** A Workspace read: a `WorkspaceQueryError` answers with its own code; anything else throws. */
function workspaceQueryMethod<Decoded>(
  decode: (payload: Uint8Array) => Decoded,
  query: (request: Decoded, principal: { userId: string } | undefined) => Promise<Uint8Array>,
): CentrifugoRpcMethod {
  return (payload, metadata) =>
    query(decode(payload), userPrincipal(metadata)).catch((error) => {
      if (error instanceof WorkspaceQueryError) return { code: error.code, message: error.message };
      throw error;
    });
}

export function createWorkspaceListMethod(useCase: WorkspaceQueryUseCase): CentrifugoRpcMethod {
  return workspaceQueryMethod(decodeWorkspaceListRequest, (request, principal) =>
    useCase.list(request, principal),
  );
}
export function createWorkspaceGetMethod(useCase: WorkspaceQueryUseCase): CentrifugoRpcMethod {
  return workspaceQueryMethod(decodeWorkspaceGetRequest, (request, principal) =>
    useCase.get(request, principal),
  );
}

export {
  type CentrifugoRpcRequest,
  type CentrifugoRpcMetadata,
  type AuthenticatedDaemonPrincipal,
  type CentrifugoRpcError,
  CentrifugoRpcAuthenticationError,
  type CentrifugoRpcHandlerResult,
  type CentrifugoRpcMethod,
  type CentrifugoRpcAuthenticate,
  type CentrifugoProxyAuthorizer,
} from "./rpc-types.server";
import type {
  CentrifugoRpcRequest,
  CentrifugoRpcMetadata,
  CentrifugoRpcError,
  CentrifugoRpcMethod,
  CentrifugoRpcAuthenticate,
  CentrifugoProxyAuthorizer,
} from "./rpc-types.server";

const errors = {
  malformed: { code: 400, message: "invalid RPC request" },
  missing: { code: 422, message: "RPC request is missing a method or payload" },
  unknown: { code: 404, message: "unknown RPC method" },
  failed: { code: 500, message: "RPC method failed" },
} as const;

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(error: CentrifugoRpcError) {
  const safe = error.code >= 400 && error.code <= 1999 ? error : errors.failed;
  return response({ error: safe });
}

function decodePayload(request: CentrifugoRpcRequest) {
  if (typeof request.b64data === "string") {
    try {
      return Uint8Array.from(atob(request.b64data), (character) => character.charCodeAt(0));
    } catch {
      return undefined;
    }
  }
  if (Object.prototype.hasOwnProperty.call(request, "data")) {
    try {
      return utf8Encoder.encode(JSON.stringify(request.data));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export class CentrifugoRpcHandler {
  readonly #methods: ReadonlyMap<string, CentrifugoRpcMethod>;
  readonly #authenticateEnvelope?: CentrifugoRpcAuthenticate;
  readonly #authorizeProxyRequest?: CentrifugoProxyAuthorizer;

  constructor(options: {
    methods: ReadonlyMap<string, CentrifugoRpcMethod> | Record<string, CentrifugoRpcMethod>;
    authenticateEnvelope?: CentrifugoRpcAuthenticate;
    authorizeProxyRequest?: CentrifugoProxyAuthorizer;
  }) {
    this.#methods = new Map(
      options.methods instanceof Map ? options.methods : Object.entries(options.methods),
    );
    this.#authenticateEnvelope = options.authenticateEnvelope;
    this.#authorizeProxyRequest = options.authorizeProxyRequest;
  }

  async handleRequest(request: Request, fixedMethod?: string): Promise<Response> {
    try {
      await this.#authorizeProxyRequest?.(request);
    } catch {
      return errorResponse({
        code: 403,
        message: "RPC request is not authorized",
      });
    }
    let envelope: CentrifugoRpcRequest;
    try {
      envelope = await request.json();
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
        throw new Error("not an object");
    } catch {
      return errorResponse(errors.malformed);
    }

    const payload = decodePayload(envelope);
    const requestedMethod = fixedMethod ?? envelope.method;
    if (typeof requestedMethod !== "string" || !requestedMethod || !payload)
      return errorResponse(errors.missing);
    const method = this.#methods.get(requestedMethod);
    if (!method) return errorResponse(errors.unknown);

    try {
      const principal =
        (await this.#authenticateEnvelope?.(envelope, request)) ??
        (typeof envelope.user === "string"
          ? { userId: envelope.user, workspaceId: "", computerId: "" }
          : { userId: "", workspaceId: "", computerId: "" });
      const result = await method(payload, {
        principal,
        client: envelope.client,
        transport: envelope.transport,
        protocol: envelope.protocol,
        encoding: envelope.encoding,
      });
      if (result instanceof Uint8Array)
        return response({ result: { b64data: Buffer.from(result).toString("base64") } });
      return errorResponse(result);
    } catch (error) {
      return errorResponse(handleRequestError(error));
    }
  }
}

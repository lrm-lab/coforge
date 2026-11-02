import {
  decodeAgentReminderOperationRequest,
  decodeAppConfigSnapshotRequest,
  decodeReminderFireRequest,
  decodeReminderSnapshotRequest,
  encodeAgentReminderOperationResponse,
} from "@lrm/coforge-sdk/internal";
import type { AgentAppConfigs } from "#src/server/agent-app-configs/agent-app-configs.server";
import type { Reminders } from "#src/server/reminders/reminders.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";

export const createAgentReminderMethod =
  (reminders: Reminders): CentrifugoRpcMethod =>
  async (payload, metadata) => {
    let request;
    try {
      request = decodeAgentReminderOperationRequest(payload);
      if (
        metadata.principal.agentId !== request.agentId ||
        metadata.principal.workspaceId !== request.workspaceId ||
        metadata.principal.computerId !== request.computerId
      )
        throw new Error("reminder operation principal scope is not authorized");
      return encodeAgentReminderOperationResponse(
        await reminders.execute(request, metadata.principal.userId!),
      );
    } catch (error) {
      if (request)
        return encodeAgentReminderOperationResponse({
          idempotencyKey: request.idempotencyKey,
          workspaceId: request.workspaceId,
          computerId: request.computerId,
          agentId: request.agentId,
          accepted: false,
          reason: error instanceof Error ? error.message : "reminder operation rejected",
          reminders: [],
          events: [],
        });
      return { code: 400, message: "invalid reminder operation request" };
    }
  };

/** One RPC a Workspace daemon sends for its own Computer. */
function daemonOwnScopeMethod<Decoded extends { workspaceId: string; computerId: string }>(
  decode: (payload: Uint8Array) => Decoded,
  run: (request: Decoded) => Promise<Uint8Array>,
  messages: { unauthorized: string; rejected: string },
): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    try {
      const request = decode(payload);
      if (
        metadata.principal.workspaceId !== request.workspaceId ||
        metadata.principal.computerId !== request.computerId
      )
        throw new Error(messages.unauthorized);
      return await run(request);
    } catch (error) {
      return {
        code: 403,
        message: error instanceof Error ? error.message : messages.rejected,
      };
    }
  };
}

export const createReminderFireMethod = (reminders: Reminders): CentrifugoRpcMethod =>
  daemonOwnScopeMethod(decodeReminderFireRequest, (request) => reminders.fireFromDaemon(request), {
    unauthorized: "reminder fire is not authorized",
    rejected: "reminder fire rejected",
  });

export const createReminderSnapshotMethod = (reminders: Reminders): CentrifugoRpcMethod =>
  daemonOwnScopeMethod(
    decodeReminderSnapshotRequest,
    (request) => reminders.snapshotForDaemon(request),
    {
      unauthorized: "reminder snapshot is not authorized",
      rejected: "reminder snapshot rejected",
    },
  );

export const createAppConfigSnapshotMethod = (
  configs: Pick<AgentAppConfigs, "snapshotForDaemon">,
): CentrifugoRpcMethod =>
  daemonOwnScopeMethod(
    decodeAppConfigSnapshotRequest,
    (request) => configs.snapshotForDaemon(request),
    {
      unauthorized: "app config snapshot is not authorized",
      rejected: "app config snapshot rejected",
    },
  );

import { isChannelOperation, type ChannelCommand } from "@lrm/coforge-sdk/internal";
import {
  actionCardActionSchema,
  validateActionCardAction,
  type AgentActionPrepareRequest,
} from "@lrm/coforge-sdk/agent";

/** Readers of the local proxy's channel and action-card request bodies; each answers the request
 * it stands for, or a `400`. */

type JsonObject = Record<string, unknown>;
const badRequest = () => new Response("bad request", { status: 400 });

export function parseChannelCommand(payload: JsonObject): ChannelCommand | Response {
  if (
    typeof payload.idempotencyKey !== "string" ||
    payload.idempotencyKey.length === 0 ||
    !isChannelOperation(payload.operation) ||
    (payload.target !== undefined && typeof payload.target !== "string") ||
    (payload.name !== undefined && typeof payload.name !== "string") ||
    (payload.description !== undefined && typeof payload.description !== "string") ||
    (payload.user !== undefined && typeof payload.user !== "string") ||
    (payload.agent !== undefined && typeof payload.agent !== "string") ||
    (payload.operation !== "create" && typeof payload.target !== "string") ||
    (payload.operation === "create" && typeof payload.name !== "string") ||
    (payload.operation === "update" &&
      payload.name === undefined &&
      payload.description === undefined) ||
    (["add-member", "remove-member"].includes(payload.operation) &&
      (payload.user === undefined) === (payload.agent === undefined))
  )
    return badRequest();
  return {
    idempotencyKey: payload.idempotencyKey,
    operation: payload.operation,
    target: payload.target,
    name: payload.name,
    description: payload.description,
    user: payload.user,
    agent: payload.agent,
  };
}

export function parseActionPrepareRequest(
  payload: JsonObject,
): AgentActionPrepareRequest | Response {
  if (typeof payload.target !== "string" || !payload.target) return badRequest();
  const parsedAction = actionCardActionSchema.safeParse(payload.action);
  if (!parsedAction.success) return badRequest();
  if (validateActionCardAction(parsedAction.data)) return badRequest();
  return { target: payload.target, action: parsedAction.data };
}

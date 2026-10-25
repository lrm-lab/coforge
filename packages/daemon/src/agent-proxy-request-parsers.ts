import {
  isChannelOperation,
  UUID_LIKE_PATTERN,
  type ChannelCommand,
  type LocalInboxRequest,
} from "@lrm/coforge-sdk/internal";
import {
  actionCardActionSchema,
  AGENT_MENTION_ACTION_MAX_IDS,
  MENTION_PENDING_MAX_LIMIT,
  isAgentMentionActionKind,
  type AgentMentionExecuteRequest,
  type AgentInboxRequest,
  AGENT_ATTACHMENT_COMMENTS_MAX_LIMIT,
  type AgentAttachmentCommentsRequest,
  type AgentMentionPendingRequest,
  isAgentInboxView,
  type AgentAppConfigUpdateRequest,
  decodeAgentAppConfigPatch,
  type AgentProfileUpdateRequest,
  type GitHubCommitTrailersRequest,
  type GitHubCredentialRequest,
  validateActionCardAction,
  type AgentActionPrepareRequest,
} from "@lrm/coforge-sdk/agent";

/** Readers of the local proxy's channel, action-card, mention, profile and GitHub request bodies; each answers the request
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

/** A `message search` position that is not a non-negative integer `offset` or a non-empty
 * `cursor`. */
export function invalidSearchPosition(payload: JsonObject): boolean {
  const { offset, cursor } = payload;
  return (
    (offset !== undefined && (!Number.isInteger(offset) || (offset as number) < 0)) ||
    (cursor !== undefined && (typeof cursor !== "string" || cursor.length === 0))
  );
}

export function parseSearchPosition(payload: JsonObject) {
  const { offset, cursor } = payload;
  return {
    offset: typeof offset === "number" ? offset : undefined,
    cursor: typeof cursor === "string" ? cursor : undefined,
  };
}

/** Decodes a required path param; an undecodable or empty one is a `400`. */
export function decodePathParam(param: string): string | Response {
  try {
    return decodeURIComponent(param) || badRequest();
  } catch {
    return badRequest();
  }
}

/** The SDK's patch shape plus the key the CLI names its request with; whether each key and value
 * belongs to the App is the cloud's answer. */
export function parseAppConfigUpdate(
  param: string,
  fields: JsonObject,
): AgentAppConfigUpdateRequest | Response {
  const appId = decodePathParam(param);
  if (appId instanceof Response) return appId;
  const change = decodeAgentAppConfigPatch(fields);
  const { idempotencyKey } = fields;
  if (!change || typeof idempotencyKey !== "string" || !idempotencyKey) return badRequest();
  return { appId, ...change, idempotencyKey };
}

/** `inbox check`'s unread list: an optional `view` and `before`, each valid or a `400`. */
export function parseInboxListQuery(params: URLSearchParams): AgentInboxRequest | Response {
  const view = params.get("view") ?? undefined;
  const raw = params.get("before");
  const before = raw === null ? undefined : Number(raw);
  if (view !== undefined && !isAgentInboxView(view)) return badRequest();
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) return badRequest();
  return { view, before };
}

/** `attachment comments`: the attachment's full id from the path, and an optional `limit` and
 * `before`, each valid or a `400`. */
export function parseAttachmentCommentsRequest(
  param: string,
  params: URLSearchParams,
): AgentAttachmentCommentsRequest | Response {
  const attachmentId = decodePathParam(param);
  if (attachmentId instanceof Response) return attachmentId;
  const number = (name: string) => (params.has(name) ? Number(params.get(name)) : undefined);
  const limit = number("limit");
  const before = number("before");
  if (!UUID_LIKE_PATTERN.test(attachmentId)) return badRequest();
  if (
    limit !== undefined &&
    (!Number.isInteger(limit) || limit < 1 || limit > AGENT_ATTACHMENT_COMMENTS_MAX_LIMIT)
  )
    return badRequest();
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) return badRequest();
  return { attachmentId, limit, before };
}

/** `mention pending`'s optional `limit`: an integer from 1 to the server's maximum page. */
export function parseMentionPendingLimit(
  raw: string | null,
): AgentMentionPendingRequest | Response {
  if (raw === null) return {};
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MENTION_PENDING_MAX_LIMIT)
    return badRequest();
  return { limit };
}

export function parseInboxRequest(
  payload: JsonObject,
  context: string,
): LocalInboxRequest | Response {
  if (typeof payload.idempotencyKey !== "string" || payload.operation !== "check")
    return badRequest();
  return { idempotencyKey: payload.idempotencyKey, context, operation: "check" };
}

export function parseMentionExecuteFields(
  fields: JsonObject,
): AgentMentionExecuteRequest | Response {
  const { action, resolutionIds: ids } = fields;
  if (
    !isAgentMentionActionKind(action) ||
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > AGENT_MENTION_ACTION_MAX_IDS ||
    ids.some((id) => typeof id !== "string" || !UUID_LIKE_PATTERN.test(id))
  )
    return badRequest();
  return { action, resolutionIds: ids as string[] };
}

export function parseProfileUpdateFields(fields: JsonObject): AgentProfileUpdateRequest | Response {
  if (
    (fields.displayName !== undefined && typeof fields.displayName !== "string") ||
    (fields.description !== undefined && typeof fields.description !== "string")
  )
    return badRequest();
  return {
    ...(fields.displayName !== undefined ? { displayName: fields.displayName as string } : {}),
    ...(fields.description !== undefined ? { description: fields.description as string } : {}),
  };
}

export function parseGithubCredentialRequest(
  payload: JsonObject,
): GitHubCredentialRequest | Response {
  if (Object.keys(payload).length !== 0) return badRequest();
  return {};
}

export function parseGithubCommitTrailersRequest(
  payload: JsonObject,
): GitHubCommitTrailersRequest | Response {
  if (payload.repository !== null && typeof payload.repository !== "string") return badRequest();
  return { repository: payload.repository };
}

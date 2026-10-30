import {
  isValidMentionSelectorArray,
  isValidReactionEmoji,
  type LocalAgentMessageRequest,
  MESSAGE_ANCHOR_SOURCE,
  UUID_LIKE_PATTERN,
  UUID_LIKE_SOURCE,
} from "@lrm/coforge-sdk/internal";
import { AgentPreflightError } from "#src/daemon-runtime/agent-preflight-error";
import { invalidSearchPosition, parseSearchPosition } from "./agent-proxy-request-parsers";

const MESSAGE_ID_ANCHOR = new RegExp(`^(?:${MESSAGE_ANCHOR_SOURCE}|${UUID_LIKE_SOURCE})$`, "i");
const UUID = UUID_LIKE_PATTERN;
const badRequest = () => new Response("bad request", { status: 400 });

type JsonObject = Record<string, unknown>;

/** The Agent's `coforge message` request body: validated field by field, with identity taken
 * exclusively from the token binding — never from caller-supplied fields. */
export function parseMessageRequest(
  payload: JsonObject,
  binding: { context: string },
): LocalAgentMessageRequest | Response {
  if (
    typeof payload.idempotencyKey !== "string" ||
    payload.idempotencyKey.length === 0 ||
    ![
      "check",
      "read",
      "search",
      "send",
      "continue",
      "mute",
      "unmute",
      "thread-unfollow",
      "resolve",
      "react",
      "unreact",
    ].includes(payload.operation as string) ||
    (payload.operation === "continue" &&
      (typeof payload.continuationId !== "string" ||
        payload.continuationId.length === 0 ||
        !["a", "b", "c", "d"].includes(payload.continuationChoice as string))) ||
    (payload.operation !== "continue" &&
      (payload.continuationId !== undefined || payload.continuationChoice !== undefined)) ||
    (payload.continueAnyway !== undefined && typeof payload.continueAnyway !== "boolean") ||
    (payload.sendDraft !== undefined && typeof payload.sendDraft !== "boolean") ||
    (payload.expectedDraftKey !== undefined &&
      (typeof payload.expectedDraftKey !== "string" ||
        payload.expectedDraftKey.trim().length === 0)) ||
    (payload.freshnessContextMode !== undefined &&
      payload.freshnessContextMode !== "inline" &&
      payload.freshnessContextMode !== "withheld") ||
    [payload.before, payload.after, payload.around].some(
      (anchor) => anchor !== undefined && (typeof anchor !== "string" || anchor.length === 0),
    ) ||
    (payload.operation === "read" &&
      [payload.before, payload.after, payload.around].filter((anchor) => anchor !== undefined)
        .length > 1) ||
    (payload.operation === "search" && payload.around !== undefined) ||
    (payload.limit !== undefined &&
      (typeof payload.limit !== "number" ||
        !Number.isInteger(payload.limit) ||
        payload.limit < 1 ||
        payload.limit > 100)) ||
    invalidSearchPosition(payload) ||
    (payload.query !== undefined &&
      (typeof payload.query !== "string" || payload.query.trim().length === 0)) ||
    (payload.sender !== undefined &&
      (typeof payload.sender !== "string" ||
        !/^@[a-z0-9][a-z0-9_-]{0,31}$/.test(payload.sender))) ||
    (payload.sort !== undefined && payload.sort !== "relevance" && payload.sort !== "recent") ||
    (payload.operation === "search" &&
      !payload.query &&
      !payload.target &&
      !payload.sender &&
      !payload.before &&
      !payload.after) ||
    (["resolve", "react", "unreact"].includes(payload.operation as string) &&
      (typeof payload.messageId !== "string" || !MESSAGE_ID_ANCHOR.test(payload.messageId))) ||
    (["react", "unreact"].includes(payload.operation as string) &&
      (typeof payload.emoji !== "string" || !isValidReactionEmoji(payload.emoji))) ||
    (payload.attachmentIds !== undefined &&
      (!Array.isArray(payload.attachmentIds) ||
        payload.attachmentIds.some((id) => typeof id !== "string" || !UUID.test(id)))) ||
    (payload.targetConfirmed !== undefined && typeof payload.targetConfirmed !== "boolean") ||
    (payload.unread !== undefined && typeof payload.unread !== "boolean") ||
    (payload.mentions !== undefined && !isValidMentionSelectorArray(payload.mentions))
  )
    return badRequest();
  // A key names the draft `--send-draft` would resend; without `--send-draft` there is none to
  // check, so the request is refused here, in the runtime's own precondition contract.
  if (payload.expectedDraftKey !== undefined && payload.sendDraft !== true)
    throw new AgentPreflightError(
      "--expected-draft-key can only be used together with --send-draft.",
      "EXPECTED_DRAFT_KEY_REQUIRES_SEND_DRAFT",
      { draftSaved: false },
    );
  return {
    idempotencyKey: payload.idempotencyKey,
    operation: payload.operation as LocalAgentMessageRequest["operation"],
    target: typeof payload.target === "string" ? payload.target : undefined,
    content: typeof payload.content === "string" ? payload.content : undefined,
    ...(typeof payload.message === "string" ? { message: payload.message } : {}),
    continueAnyway: payload.continueAnyway === true || undefined,
    continuationId: typeof payload.continuationId === "string" ? payload.continuationId : undefined,
    continuationChoice:
      payload.continuationChoice === "a" ||
      payload.continuationChoice === "b" ||
      payload.continuationChoice === "c" ||
      payload.continuationChoice === "d"
        ? payload.continuationChoice
        : undefined,
    sendDraft: payload.sendDraft === true || undefined,
    expectedDraftKey:
      typeof payload.expectedDraftKey === "string" ? payload.expectedDraftKey : undefined,
    before: typeof payload.before === "string" ? payload.before : undefined,
    after: typeof payload.after === "string" ? payload.after : undefined,
    around: typeof payload.around === "string" ? payload.around : undefined,
    limit: typeof payload.limit === "number" ? payload.limit : undefined,
    unread: payload.unread === true || undefined,
    query: typeof payload.query === "string" ? payload.query : undefined,
    sender: typeof payload.sender === "string" ? payload.sender : undefined,
    sort: payload.sort === "relevance" || payload.sort === "recent" ? payload.sort : undefined,
    ...parseSearchPosition(payload),
    freshnessContextMode:
      payload.freshnessContextMode === "inline" || payload.freshnessContextMode === "withheld"
        ? payload.freshnessContextMode
        : undefined,
    messageId: typeof payload.messageId === "string" ? payload.messageId : undefined,
    emoji: typeof payload.emoji === "string" ? payload.emoji : undefined,
    attachmentIds: Array.isArray(payload.attachmentIds)
      ? (payload.attachmentIds as string[])
      : undefined,
    mentions: Array.isArray(payload.mentions)
      ? (payload.mentions as LocalAgentMessageRequest["mentions"])
      : undefined,
    targetConfirmed: payload.targetConfirmed === true || undefined,
    // Identity is exclusively the token binding. Never accept caller
    // supplied agentId/context fields as authorization input.
    context: binding.context,
    // The Agent API key stays in this trusted registration and is
    // never serialized into the child process request.
  };
}

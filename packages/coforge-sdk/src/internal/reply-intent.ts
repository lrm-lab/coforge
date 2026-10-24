import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentActivitySchema,
  ReplyIntentSchema,
  type AgentActivity as AgentActivityMessage,
} from "#src/internal/gen/coforge/rpc/v1/workspace_pb";
import { isActivityCallId } from "./activity-entries";
import { agentActivityFromMessage } from "./agent-activity-codec";
import type { AgentActivity } from "./index";

/**
 * The "about to post" signal: an Agent's tool call is sending a message, so its sentence in the
 * conversation is coming. It rides the Agent Activity channel as an additive field of
 * `AgentActivity` (`reply_intent`), but it is not an observation: it has no launch or sequence, is
 * never stored and never changes the Agent's display. Best effort like all Activity; a lost frame
 * only means the line is missing or ends at its deadline.
 *
 * Wire shape and lifecycle: docs/observability/reply-intent.md.
 */
export const REPLY_INTENT_PHASE = { START: "start", END: "end" } as const;
export type ReplyIntentPhase = (typeof REPLY_INTENT_PHASE)[keyof typeof REPLY_INTENT_PHASE];

/** The `detail_kind` a reply intent frame carries, for anyone reading raw frames. */
export const REPLY_INTENT_DETAIL_KIND = "reply_intent";

/** How often the daemon repeats a start while its call runs. */
export const REPLY_INTENT_REFRESH_MS = 8_000;
/** How long one call may stay announced before the daemon ends it. */
export const REPLY_INTENT_MAX_MS = 120_000;
/** The most calls one Agent announces at once; further sends are not announced. */
export const REPLY_INTENT_MAX_LIVE_PER_AGENT = 4;
/** How long a browser keeps a start that was not repeated: more than two refresh periods. */
export const REPLY_INTENT_DEADLINE_MS = 20_000;

/** The longest target, in code points: the Activity tool-input limit the daemon reads it under. */
const MAX_TARGET_CODE_POINTS = 200;
const MAX_ID_LENGTH = 512;

/** Whether `value` can be carried as a send target: not empty, at most 200 code points. */
export function isReplyIntentTarget(value: string): boolean {
  return value.length > 0 && [...value].length <= MAX_TARGET_CODE_POINTS;
}

export type ReplyIntent = {
  phase: ReplyIntentPhase;
  /** The tool call this signal is about; a start repeats it, an end names it. */
  callId: string;
  /** The Agent's raw send target (`#channel`, `@user`, `#channel:thread`), on a start and on its
   * end. Daemon to server only. */
  target?: string;
  /** The target was known before the call's arguments finished. */
  early?: boolean;
  /** The conversation the server resolved the target to. Server to browser only. */
  conversationId?: string;
  /** The thread the server resolved it to; absent for a top-level post. */
  threadRootId?: string;
};

export type AgentReplyIntent = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  agentId: string;
  observedAtMs: number;
  intent: ReplyIntent;
};

export function encodeAgentReplyIntent(value: AgentReplyIntent): Uint8Array {
  validateAgentReplyIntent(value);
  const { intent } = value;
  return toBinary(
    AgentActivitySchema,
    create(AgentActivitySchema, {
      protocolMajor: value.protocolMajor,
      requestId: value.requestId,
      workspaceId: value.workspaceId,
      agentId: value.agentId,
      detailKind: REPLY_INTENT_DETAIL_KIND,
      level: "info",
      observedAtMs: BigInt(value.observedAtMs),
      replyIntent: create(ReplyIntentSchema, {
        phase: intent.phase,
        callId: intent.callId,
        target: intent.target ?? "",
        early: intent.early ?? false,
        conversationId: intent.conversationId ?? "",
        threadRootId: intent.threadRootId ?? "",
      }),
    }),
  );
}

/** What one Activity-channel frame carries: an "about to post" signal or an observation. */
export type AgentActivityFrame = { replyIntent: AgentReplyIntent } | { activity: AgentActivity };

/**
 * Parses an Activity-channel frame once and returns what it carries. Throws for bytes that are
 * not a frame, a reply intent that breaks the contract, or an observation that does.
 */
export function decodeAgentActivityFrame(bytes: Uint8Array): AgentActivityFrame {
  const frame = fromBinary(AgentActivitySchema, bytes);
  return frame.replyIntent
    ? { replyIntent: replyIntentFromMessage(frame, frame.replyIntent) }
    : { activity: agentActivityFromMessage(frame) };
}

function replyIntentFromMessage(
  frame: AgentActivityMessage,
  intent: NonNullable<AgentActivityMessage["replyIntent"]>,
): AgentReplyIntent {
  const value: AgentReplyIntent = {
    protocolMajor: frame.protocolMajor,
    requestId: frame.requestId,
    workspaceId: frame.workspaceId,
    agentId: frame.agentId,
    observedAtMs: Number(frame.observedAtMs),
    intent: {
      phase: intent.phase as ReplyIntentPhase,
      callId: intent.callId,
      ...(intent.target ? { target: intent.target } : {}),
      ...(intent.early ? { early: true } : {}),
      ...(intent.conversationId ? { conversationId: intent.conversationId } : {}),
      ...(intent.threadRootId ? { threadRootId: intent.threadRootId } : {}),
    },
  };
  validateAgentReplyIntent(value);
  return value;
}

function validateAgentReplyIntent(value: AgentReplyIntent): void {
  const { intent } = value;
  if (
    value.protocolMajor !== 1 ||
    ![value.requestId, value.workspaceId, value.agentId].every(
      (id) => id.length > 0 && id.length <= MAX_ID_LENGTH,
    ) ||
    !Number.isSafeInteger(value.observedAtMs) ||
    value.observedAtMs < 1 ||
    !Object.values(REPLY_INTENT_PHASE).includes(intent.phase) ||
    !isActivityCallId(intent.callId) ||
    (intent.target !== undefined && !isReplyIntentTarget(intent.target)) ||
    (intent.phase === REPLY_INTENT_PHASE.START && !intent.target && !intent.conversationId) ||
    (intent.threadRootId !== undefined && !intent.conversationId)
  )
    throw new Error("invalid agent reply intent");
}

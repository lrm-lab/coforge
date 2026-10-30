import { z } from "zod";

import type { MentionRef } from "./mention-text";

/** The longest note a forward carries: a message body's browser limit. */
export const FORWARD_NOTE_MAX_LENGTH = 8_000;

/** Most conversations one forward reaches. */
export const FORWARD_DESTINATIONS_MAX = 10;

/**
 * What a forwarded message carries in a browser message (`mapBrowserMessage`): the snapshot of the
 * original, frozen when it was forwarded. `sourceBody` is plain text (mentions already read back as
 * names), never a stored body. The card's attachments are the message's own `attachments`.
 */
export type ForwardedMessageView = {
  /** The original sender's handle, as Raft names them on the card. */
  sourceSenderHandle: string;
  /** ISO timestamp the original was sent. */
  sourceCreatedAt: string;
  sourceBody: string;
  /** The original as stored (its `<@kind:...>` tokens) with the mentions it was read with, when the
   * forward kept them: the card draws chips from these, and from `sourceBody` when absent. */
  sourceRawBody?: string;
  sourceMentions?: MentionRef[];
  /** `name` is the channel's current name (its name when forwarded once it is gone), null for a DM. */
  sourceConversation: { id: string; name: string | null };
  sourceThreadRootId?: string;
  /** Absent once the original was deleted; "open original" goes with it. */
  sourceMessageId?: string;
  /** True only when this viewer can open the original now: it still exists and they can see its
   * conversation. Computed per viewer. */
  sourceAccessible: boolean;
};

export const forwardMessageInputSchema = z.object({
  /** One id per forward attempt; a retry with the same id re-sends only what failed. */
  requestId: z.uuid(),
  /** Exactly one message for now. */
  sourceMessageIds: z.array(z.uuid()).length(1),
  /** Destination conversation ids (channels or direct conversations). */
  destinations: z
    .array(z.uuid())
    .min(1)
    .max(FORWARD_DESTINATIONS_MAX)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "destinations must not contain duplicates",
    }),
  note: z.string().trim().max(FORWARD_NOTE_MAX_LENGTH).optional(),
});
export type ForwardMessageInput = z.infer<typeof forwardMessageInputSchema>;

/** Why one destination did not take the forward. `not_joined`: a channel the forwarder is not in;
 * the client asks them to join it and retries. */
export type ForwardFailureCode = "not_joined" | "archived" | "read_only" | "no_access" | "failed";

export type ForwardDestinationResult =
  | { destination: string; status: "success"; message: { id: string; sequence: number } }
  | { destination: string; status: "failed"; error: { code: ForwardFailureCode } };

/** `idempotent_replay`: every destination had already succeeded under this request id. */
export type ForwardOutcome = "success" | "idempotent_replay" | "partial_failure" | "all_failed";

export type ForwardMessageResult = {
  outcome: ForwardOutcome;
  results: ForwardDestinationResult[];
};

export const forwardTargetsInputSchema = z.object({
  q: z.string().trim().max(100).default(""),
  limit: z.number().int().min(1).max(50).default(20),
});

/**
 * One place a message can be forwarded to. A person or an Agent without a DM yet has no
 * `conversationId`: the client opens the DM first (`openDirectConversation`) and forwards to the
 * id that returns. `joined` is false for a channel the viewer has not joined; `canSend` is false
 * where a forward would be refused (an archived channel).
 */
export type ForwardTarget =
  | {
      kind: "channel";
      conversationId: string;
      name: string;
      joined: boolean;
      canSend: boolean;
    }
  | {
      kind: "person";
      userId: string;
      name: string;
      avatarUrl: string | null;
      conversationId?: string;
      joined: true;
      canSend: true;
    }
  | {
      kind: "agent";
      agentId: string;
      name: string;
      handle: string;
      avatarUrl: string;
      conversationId?: string;
      joined: true;
      canSend: true;
    };

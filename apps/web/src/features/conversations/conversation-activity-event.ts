import { z } from "zod";
import { publicationDataOrUndefined } from "#src/features/realtime/publication-data";
import type { PreviewCard } from "./action-card-preview";
import type { PreviewNotice } from "./preview-line";

/**
 * One message, to each person it concerns, on their own channel (`chat:user:<id>`): the data the
 * Chat sidebar needs to write that conversation's row in place (its new last message) and to
 * count the message for the viewer's unread badge and Activity dot. Published only to people who
 * may read the conversation — a channel's active members, or a thread's followers for a reply —
 * so a channel's text never reaches a tab that is not in it, and never to the whole Workspace.
 *
 * The viewer's own messages arrive too (their other tabs and devices must move the row); the page
 * never counts them, and a system message (`sender.kind === "system"`, no sender id) never counts
 * either, exactly as the unread rule in `human-unread.server.ts` says.
 */
export type ConversationActivityEvent = {
  type: "conversation.activity.v1";
  workspaceId: string;
  conversationId: string;
  messageId: string;
  sequence: number;
  /** Which list's row this conversation has: a channel's or a direct message's. */
  kind: "channel" | "direct";
  /** The message's own time (ISO), the row's new last-message time. */
  createdAt: string;
  /** The message body as one line for the row, as the list read gives it. */
  preview: string;
  /** Set when the message is a system notice: what the row renders it from in the viewer's
   * language, `preview` being its stored English. */
  notice?: PreviewNotice;
  /** Set when the message is an action card, likewise. */
  card?: PreviewCard;
  sender: { kind: "user" | "agent" | "system"; name: string };
  /** The person who wrote it; absent for an Agent's or a system message. */
  senderUserId?: string;
  /** The Agent that wrote it, when an Agent did. */
  senderAgentId?: string;
  /** Set only for a thread reply: the row keeps its last *top-level* message, so a reply lights
   * the Activity dot for the thread's followers but changes no row. */
  threadRootId?: string;
  muted?: true;
  mentioned?: true;
  unreadThreadCount?: number;
  threadMentioned?: true;
};

const nonEmptyString = z.string().min(1);

const previewNoticeSchema = z
  .object({
    kind: nonEmptyString,
    params: z.unknown(),
  })
  .transform((value) => value as PreviewNotice);

const previewCardSchema = z
  .object({
    kind: nonEmptyString,
    params: z.record(z.string(), z.unknown()),
    hint: z.string().optional(),
  })
  .transform((value) => value as PreviewCard);

const conversationActivityEventSchema = z.object({
  type: z.literal("conversation.activity.v1"),
  workspaceId: nonEmptyString,
  conversationId: nonEmptyString,
  messageId: nonEmptyString,
  sequence: z.int().min(1),
  kind: z.enum(["channel", "direct"]),
  createdAt: nonEmptyString,
  preview: z.string(),
  notice: previewNoticeSchema.optional(),
  card: previewCardSchema.optional(),
  sender: z.object({
    kind: z.enum(["user", "agent", "system"]),
    name: nonEmptyString,
  }),
  senderUserId: nonEmptyString.optional(),
  senderAgentId: nonEmptyString.optional(),
  threadRootId: nonEmptyString.optional(),
  muted: z.literal(true).optional(),
  mentioned: z.literal(true).optional(),
  unreadThreadCount: z.int().nonnegative().optional(),
  threadMentioned: z.literal(true).optional(),
});

/** Undefined for anything else on the channel, binary publications included: `chat:user:` also
 * carries an Agent's reply intent in a direct conversation and Pi chat frames. */
export function decodeConversationActivityEvent(
  input: unknown,
): ConversationActivityEvent | undefined {
  const parsed = conversationActivityEventSchema.safeParse(publicationDataOrUndefined(input));
  return parsed.success ? parsed.data : undefined;
}

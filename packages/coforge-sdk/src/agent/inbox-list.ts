/**
 * Wire contract for `coforge inbox check`'s list of unread conversations
 * (`GET /api/agent/v1/inbox/conversations`). The daemon's own not-yet-delivered messages and App
 * items are a separate local answer; the CLI merges the two.
 */

import { z } from "zod";

export const AGENT_INBOX_VIEWS = ["unread", "mentions"] as const;
export type AgentInboxView = (typeof AGENT_INBOX_VIEWS)[number];

export function isAgentInboxView(value: unknown): value is AgentInboxView {
  return (AGENT_INBOX_VIEWS as readonly unknown[]).includes(value);
}

/** Conversations in one page of the list; the next page is `before=nextBefore`. The cursor is
 * opaque to callers (a message seq counts per conversation, so it is not one): copy it, never
 * read it as a message seq. */
export const AGENT_INBOX_PAGE_SIZE = 50;

export type AgentInboxRequest = { view?: AgentInboxView; before?: number };

export const AGENT_INBOX_ITEM_KINDS = ["dm", "channel", "thread"] as const;
export type AgentInboxItemKind = (typeof AGENT_INBOX_ITEM_KINDS)[number];

/** One unread conversation: an `@user` direct chat, a `#channel`, or a followed thread
 * `#channel:xxxxxxxx-xxxx`. */
export type AgentInboxItem = {
  kind: AgentInboxItemKind;
  target: string;
  /** Other people's messages after the Agent's read position: top-level ones for a conversation,
   * replies for a thread. */
  unread: number;
  /** How many of those mention the Agent. */
  mentions: number;
  latestAt: string | null;
  latestSenderName: string | null;
  /** The Agent's read position: `message read --target <t> --after <lastReadSeq>` opens the unread. */
  lastReadSeq: number;
};

export type AgentInboxTotals = {
  /** Every unread conversation and followed thread, whatever the view or page. */
  conversations: number;
  dms: number;
  /** Conversations and threads with an unread mention. */
  mentions: number;
};

/** Response for `GET /api/agent/v1/inbox/conversations[?view=<view>][&before=<n>]`, newest
 * activity first. `nextBefore` is the latest-activity time (epoch milliseconds) of the page's
 * last conversation: conversation sequences are per conversation, so activity time is what orders
 * the list across them. */
export type AgentInboxListResponse = {
  ok: true;
  view: AgentInboxView;
  items: AgentInboxItem[];
  totals: AgentInboxTotals;
  hasMore: boolean;
  nextBefore: number | null;
  /** A one-time suggestion to mute a noisy channel, with the reason and the command. */
  muteHint?: string;
};

const countSchema = z.int().min(0);

const inboxItemSchema = z.looseObject({
  kind: z.enum(AGENT_INBOX_ITEM_KINDS),
  target: z.string(),
  unread: countSchema,
  mentions: countSchema,
  latestAt: z.string().nullable(),
  latestSenderName: z.string().nullable(),
  lastReadSeq: countSchema,
});

const inboxListResponseSchema = z.object({
  ok: z.literal(true),
  view: z.enum(AGENT_INBOX_VIEWS),
  items: z.array(inboxItemSchema),
  totals: z.object({
    conversations: countSchema,
    dms: countSchema,
    mentions: countSchema,
  }),
  hasMore: z.boolean(),
  nextBefore: countSchema.nullable(),
  muteHint: z.string().optional(),
});

export function decodeAgentInboxListResponse(value: unknown): AgentInboxListResponse {
  const parsed = inboxListResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid Agent inbox list response");
  const { muteHint, ...rest } = parsed.data;
  return muteHint === undefined ? rest : { ...rest, muteHint };
}

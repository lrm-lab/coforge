/**
 * Wire contract for `coforge inbox check`'s list of unread conversations
 * (`GET /api/agent/v1/inbox/conversations`). The daemon's own not-yet-delivered messages and App
 * items are a separate local answer; the CLI merges the two.
 */

import { isRecord } from "../internal";

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

/** One unread conversation: a `#channel` or an `@user` direct chat. */
export type AgentInboxItem = {
  target: string;
  /** Other people's top-level messages after the Agent's read position. */
  unread: number;
  /** How many of those mention the Agent. */
  mentions: number;
  latestAt: string | null;
  latestSenderName: string | null;
  /** The Agent's read position: `message read --target <t> --after <lastReadSeq>` opens the unread. */
  lastReadSeq: number;
};

export type AgentInboxTotals = {
  /** Every unread conversation, whatever the view or page. */
  conversations: number;
  dms: number;
  /** Conversations with an unread mention. */
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
};

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

function isInboxItem(value: unknown): value is AgentInboxItem {
  return (
    isRecord(value) &&
    typeof value.target === "string" &&
    isCount(value.unread) &&
    isCount(value.mentions) &&
    (value.latestAt === null || typeof value.latestAt === "string") &&
    (value.latestSenderName === null || typeof value.latestSenderName === "string") &&
    isCount(value.lastReadSeq)
  );
}

export function decodeAgentInboxListResponse(value: unknown): AgentInboxListResponse {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !isAgentInboxView(value.view) ||
    !Array.isArray(value.items) ||
    !value.items.every(isInboxItem) ||
    !isRecord(value.totals) ||
    !isCount(value.totals.conversations) ||
    !isCount(value.totals.dms) ||
    !isCount(value.totals.mentions) ||
    typeof value.hasMore !== "boolean" ||
    !(value.nextBefore === null || isCount(value.nextBefore))
  )
    throw new Error("invalid Agent inbox list response");
  return {
    ok: true,
    view: value.view,
    items: value.items,
    totals: {
      conversations: value.totals.conversations,
      dms: value.totals.dms,
      mentions: value.totals.mentions,
    },
    hasMore: value.hasMore,
    nextBefore: value.nextBefore as number | null,
  };
}

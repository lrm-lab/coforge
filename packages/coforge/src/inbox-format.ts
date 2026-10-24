import { agoLabel } from "./workspace-info-format";
import type {
  AgentInboxItem,
  AgentInboxListResponse,
  AgentInboxView,
} from "@lrm/coforge-sdk/agent";

/** A conversation with messages the daemon holds but has not delivered to the Agent yet. */
export type InboxPendingRow = {
  target: string;
  pendingCount: number;
  latestSenderHandle?: string;
  flags: string[];
  firstPendingSequence?: number;
};

export type InboxAppItem = { title?: string; summary?: string; itemId?: string };

export type InboxCheckResult = {
  view: AgentInboxView;
  before?: number;
  list: AgentInboxListResponse;
  pendingRows: InboxPendingRow[];
  appItems: InboxAppItem[];
  /** Why the daemon's own part could not be read; its rows and App items are then missing. */
  daemonError?: string;
};

type Row = { lines: string[]; next: string };

function rowOf(parts: string[], open: string): Row {
  return {
    lines: [parts.join(" · "), `  open: ${open}`],
    next: `open the first conversation above: ${open}`,
  };
}

const plural = (count: number, one: string) => `${count} ${count === 1 ? one : `${one}s`}`;

function formatAgo(iso: string | null, nowMs: number): string | null {
  const at = iso ? new Date(iso) : undefined;
  return at && Number.isFinite(at.getTime()) ? agoLabel(at, nowMs) : null;
}

const mentionsYou = (flags: readonly string[]) => flags.includes("non_member_mention");

function openCommand(target: string, afterSeq: number | undefined): string {
  return `coforge message read --target ${JSON.stringify(target)}${afterSeq ? ` --after ${afterSeq}` : ""}`;
}

function conversationRow(
  item: AgentInboxItem,
  pending: InboxPendingRow | undefined,
  nowMs: number,
): Row {
  const parts = [item.target, `${item.unread} unread`];
  if (item.mentions > 0)
    parts.push(item.mentions === 1 ? "mentions you" : `mentions you ${item.mentions}x`);
  if (pending && pending.pendingCount > 0)
    parts.push(`${pending.pendingCount} new, not yet delivered`);
  const latest = [
    item.latestSenderName ? `@${item.latestSenderName}` : null,
    formatAgo(item.latestAt, nowMs),
  ].filter(Boolean);
  if (latest.length > 0) parts.push(`latest ${latest.join(" ")}`);
  const open = openCommand(item.target, item.lastReadSeq);
  return rowOf(parts, open);
}

function pendingOnlyRow(row: InboxPendingRow): Row {
  const parts = [row.target, `${row.pendingCount} new, not yet delivered`];
  if (mentionsYou(row.flags)) parts.push("mentions you");
  if (row.latestSenderHandle) parts.push(`latest @${row.latestSenderHandle}`);
  const open = openCommand(
    row.target,
    row.firstPendingSequence === undefined ? undefined : row.firstPendingSequence - 1,
  );
  return rowOf(parts, open);
}

function header(result: InboxCheckResult, extraPending: number): string {
  const { totals } = result.list;
  if (result.view === "mentions") {
    if (totals.mentions === 0 && extraPending === 0)
      return totals.conversations === 0
        ? "Inbox: nothing unread."
        : `Inbox: no unread mentions (${plural(totals.conversations, "unread conversation")} in total).`;
    return `Inbox: ${plural(totals.mentions, "conversation")} with unread mentions (of ${plural(totals.conversations, "unread conversation")}).`;
  }
  if (totals.conversations === 0 && extraPending === 0) return "Inbox: nothing unread.";
  return `Inbox: ${plural(totals.conversations, "unread conversation")} (${plural(totals.dms, "DM")}, ${totals.mentions} with mentions).`;
}

/** `inbox check`: the unread conversations, then how to see more, the next step and App items. */
export function formatInboxCheck(result: InboxCheckResult, nowMs: number): string {
  const { list, view, before } = result;
  const pendingByTarget = new Map(result.pendingRows.map((row) => [row.target, row]));
  const listed = new Set(list.items.map((item) => item.target));
  // Rows the daemon holds for conversations the list does not show: only on the newest page.
  const extraPending =
    before === undefined
      ? result.pendingRows.filter(
          (row) =>
            row.pendingCount > 0 &&
            !listed.has(row.target) &&
            (view === "unread" || mentionsYou(row.flags)),
        )
      : [];
  const rows = [
    ...extraPending.map(pendingOnlyRow),
    ...list.items.map((item) => conversationRow(item, pendingByTarget.get(item.target), nowMs)),
  ];
  let top = header(result, extraPending.length);
  if (rows.length > 0)
    top +=
      before === undefined
        ? " Newest activity first."
        : ` Activity before seq ${before}, newest first.`;
  const sections = [top];
  if (rows.length > 0) sections.push(rows.flatMap((row) => row.lines).join("\n"));
  const viewFlag = view === "mentions" ? " --view mentions" : "";
  const trailer: string[] = [];
  if (list.hasMore && list.nextBeforeSeq !== null)
    trailer.push(`More: coforge inbox check${viewFlag} --before ${list.nextBeforeSeq}`);
  if (rows.length > 0) trailer.push(`Next: ${rows[0]!.next}`);
  else if (before !== undefined && list.totals.conversations > 0)
    trailer.push(
      `Next: no older ${view === "mentions" ? "mentions" : "unread conversations"}; run coforge inbox check${viewFlag} for the newest.`,
    );
  else if (view === "mentions" && list.totals.conversations > 0)
    trailer.push("Next: run coforge inbox check to list all unread conversations.");
  else trailer.push("Next: nothing to do; new messages will reach you as they arrive.");
  sections.push(trailer.join("\n"));
  if (result.appItems.length > 0)
    sections.push(
      [
        `App items pending: ${result.appItems.length}.`,
        ...result.appItems.map((app) =>
          `- ${app.title ?? app.itemId ?? "App item"}: ${app.summary ?? ""}`.trimEnd(),
        ),
      ].join("\n"),
    );
  if (result.daemonError)
    sections.push(
      `Daemon pending buffer unavailable (${result.daemonError}); not-yet-delivered counts and App items are not shown.`,
    );
  return sections.join("\n\n");
}

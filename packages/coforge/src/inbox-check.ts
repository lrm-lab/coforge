import type { AgentInboxListResponse, AgentInboxRequest } from "@lrm/coforge-sdk/agent";
import {
  formatInboxCheck,
  type InboxAppItem,
  type InboxCheckResult,
  type InboxPendingRow,
} from "./inbox-format";

type DaemonInbox = {
  entries?: Array<{
    kind?: string;
    messageTarget?: Partial<InboxPendingRow>;
    app?: InboxAppItem;
  }>;
};

/** The transport calls `inbox check` makes: the server's list and the daemon's own state. */
export type InboxTransport = {
  inboxList?(request: AgentInboxRequest): Promise<AgentInboxListResponse>;
  inboxCheck?(): Promise<unknown>;
};

function pendingRows(inbox: DaemonInbox): InboxPendingRow[] {
  return (inbox.entries ?? []).flatMap((entry) => {
    const row = entry.messageTarget;
    if (!row?.target) return [];
    return [
      {
        target: row.target,
        pendingCount: row.pendingCount ?? 0,
        flags: row.flags ?? [],
        ...(row.latestSenderHandle ? { latestSenderHandle: row.latestSenderHandle } : {}),
        ...(row.firstPendingSequence === undefined
          ? {}
          : { firstPendingSequence: row.firstPendingSequence }),
      },
    ];
  });
}

/**
 * `inbox check`: the server's unread conversations and the daemon's undelivered messages and App
 * items, read together. A server failure fails the command; a daemon failure is reported beside
 * the list, which is still the answer.
 */
export async function runInboxCheck(
  transport: InboxTransport,
  { view, before, json }: { view?: AgentInboxRequest["view"]; before?: number; json?: boolean },
): Promise<string> {
  if (!transport.inboxList || !transport.inboxCheck)
    throw new Error("App Inbox transport is unavailable");
  const [list, daemon] = await Promise.all([
    transport.inboxList({ view, before: before }),
    (transport.inboxCheck() as Promise<DaemonInbox>).then(
      (inbox) => ({ inbox }),
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
    ),
  ]);
  const inbox = "inbox" in daemon ? daemon.inbox : undefined;
  const result: InboxCheckResult = {
    view: list.view,
    ...(before === undefined ? {} : { before }),
    list,
    pendingRows: inbox ? pendingRows(inbox) : [],
    appItems: (inbox?.entries ?? []).flatMap((entry) =>
      entry.kind === "app" && entry.app ? [entry.app] : [],
    ),
    ...("error" in daemon ? { daemonError: daemon.error } : {}),
  };
  if (!json) return formatInboxCheck(result, Date.now());
  // Message ordering fields stay out of JSON: they are for the `--after` in the text only.
  return JSON.stringify({
    ...result,
    pendingRows: result.pendingRows.map(({ firstPendingSequence: _first, ...row }) => row),
  });
}

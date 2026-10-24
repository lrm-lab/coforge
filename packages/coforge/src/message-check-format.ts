import type { AgentMessageResponse } from "@lrm/coforge-sdk/internal";
import { formatMessageLine, formatTaskWorkflowHint } from "./message-format";

/** What `message check` got back: the drained messages, and what the daemon knows beyond them.
 * `summaries` are the conversations with unread attention before the drain, and
 * `appItemsPending` the App Inbox items waiting, present only when no message was returned. */
export type MessageCheckResult = Pick<AgentMessageResponse, "messages"> &
  Partial<Pick<AgentMessageResponse, "hasMore" | "summaries" | "appItemsPending">>;

/** The conversations still unread beyond the ones the drained messages came from. */
function stillUnread(result: MessageCheckResult): string | undefined {
  const shown = new Set(result.messages.map((message) => message.target));
  const count = new Set(
    (result.summaries ?? [])
      .map((summary) => summary.target)
      .filter((target) => !shown.has(target)),
  ).size;
  if (count === 0) return undefined;
  return `Still unread: ${count} ${count === 1 ? "conversation" : "conversations"}. Run \`coforge inbox check\` to list them.`;
}

export function formatMessageCheck(result: MessageCheckResult): string {
  const lines: string[] = [];
  if (result.messages.length > 0) {
    lines.push(result.messages.map(formatMessageLine).join("\n"), "");
    const hint = formatTaskWorkflowHint(result.messages);
    if (hint) lines.push(hint);
  }
  lines.push(
    result.hasMore
      ? "More messages are pending. Run `coforge message check` again."
      : "No more new inbox messages.",
  );
  if ((result.appItemsPending ?? 0) > 0)
    lines.push(
      `App items pending: ${result.appItemsPending}. Run \`coforge inbox check\` to inspect them.`,
    );
  const unread = stillUnread(result);
  if (unread) lines.push(unread);
  return lines.join("\n");
}

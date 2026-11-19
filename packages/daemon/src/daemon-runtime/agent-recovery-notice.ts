import type { AgentRecoveryMessage, AgentStartOpenTasks } from "@lrm/coforge-sdk/internal";
import { agentStartupCatchupInput } from "#src/agent-runtime/agent-startup";
import { inboxNoticeText } from "./inbox-notice-text";
import { buildNoticeRows, renderNoticeRows } from "./inbox-preview-rows";

export function composeRecoveryNotice(input: {
  agentId: string;
  announced: readonly AgentRecoveryMessage[];
  summaryOnly: readonly (readonly [string, number])[];
  openTasks?: AgentStartOpenTasks;
}) {
  const { rows } = buildNoticeRows({
    announced: input.announced,
    queued: [],
    agentId: input.agentId,
    previewLimit: 0,
    previewedInFull: () => false,
  });
  const lines = [
    ...renderNoticeRows(rows),
    ...input.summaryOnly.map(
      ([target, count]) => `${target} ${count} new message${count === 1 ? "" : "s"}`,
    ),
  ];
  return {
    notice: input.announced.length
      ? inboxNoticeText(lines)
      : agentStartupCatchupInput(lines, false, input.openTasks),
    recoveredMessageCount: rows.reduce((total, row) => total + row.newIds.size, 0),
    summaryUnreadCount: input.summaryOnly.reduce((total, [, count]) => total + count, 0),
  };
}

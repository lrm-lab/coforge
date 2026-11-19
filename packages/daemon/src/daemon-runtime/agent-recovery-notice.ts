import type { AgentRecoveryMessage, AgentStartOpenTasks } from "@lrm/coforge-sdk/internal";
import { agentStartupCatchupInput } from "#src/agent-runtime/agent-startup";
import { inboxNoticeText } from "./inbox-notice-text";
import { buildNoticeRows, renderNoticeRows } from "./inbox-preview-rows";

export function recoveryWakeupText(input: {
  agentId: string;
  announced: readonly AgentRecoveryMessage[];
  summaryOnly: readonly (readonly [string, number])[];
  openTasks?: AgentStartOpenTasks;
}): string {
  const rows = [
    ...renderNoticeRows(
      buildNoticeRows({
        announced: input.announced,
        queued: [],
        agentId: input.agentId,
        previewLimit: 0,
        previewedInFull: () => false,
      }).rows,
    ),
    ...input.summaryOnly.map(
      ([target, count]) => `${target} ${count} new message${count === 1 ? "" : "s"}`,
    ),
  ];
  return input.announced.length
    ? inboxNoticeText(rows)
    : agentStartupCatchupInput(rows, false, input.openTasks);
}

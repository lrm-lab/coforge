import type { AgentRecoveryMessage } from "@lrm/coforge-sdk/internal";
import { agentStartupCatchupInput } from "#src/agent-runtime/agent-startup";
import { inboxNoticeText } from "./inbox-notice-text";
import { buildNoticeRows, renderNoticeRows } from "./inbox-preview-rows";

/**
 * The wakeup text one recovery pass sends. Recovery is a wakeup, not a second copy of the
 * bodies: the same messages will come back through `coforge message check`. DM and channel
 * share `#localViewRows` (one target per line, no body), so no previews are rendered.
 * `recordModelSeen` is not advanced here — the server cursor has not moved, and `check` is
 * what advances it (and records what it showed as exact sequences). A pass that recovered
 * no message falls back to the startup catch-up input for its summary-only rows.
 */
export function recoveryWakeupText(input: {
  agentId: string;
  announced: readonly AgentRecoveryMessage[];
  summaryOnly: readonly (readonly [string, number])[];
  hasToolProfile: boolean;
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
    : agentStartupCatchupInput(rows, input.hasToolProfile);
}

import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { isBusyTone } from "./agent-activity-presentation";
import { HELD_AGENT_IDS_LIMIT } from "./extra-agent";

/**
 * The extras whose display the read must answer although they may not be busy: the ones the
 * browser shows busy and the ones whose display has lapsed (`nextDisplayRefreshDelayMs` re-reads at
 * that deadline), so a stale busy display clears by revision and a lapsed one is renewed instead
 * of being re-read every second; and the `watchedIds` a mounted view reads the display of. Deduped
 * and capped at `HELD_AGENT_IDS_LIMIT` (watched first), so the read is never rejected for its size.
 */
export function heldDisplayAgentIds(
  agents: readonly { id: string; display?: AgentDisplaySnapshot; isExtra?: true }[],
  now: number,
  watchedIds: Iterable<string> = [],
): string[] {
  const stale = agents.flatMap(({ id, display, isExtra }) =>
    isExtra &&
    display &&
    (isBusyTone(display.activityKind) ||
      (typeof display.expiresAt === "number" && display.expiresAt <= now))
      ? [id]
      : [],
  );
  return [...new Set([...watchedIds, ...stale])].slice(0, HELD_AGENT_IDS_LIMIT);
}

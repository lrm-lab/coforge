import type { AgentRuntimeEvent } from "@coforge/agent";
import { truncateCodePointsWithEllipsis } from "@lrm/coforge-sdk/internal";
import { collapseWhitespace } from "#src/code-agent/agent-instructions";

type SubagentProgress = Extract<AgentRuntimeEvent, { type: "subagent-progress" }>;

const PHASE_LABEL: Readonly<Record<SubagentProgress["phase"], string>> = {
  started: "Subagent started",
  progress: "Subagent working",
  notification: "Subagent update",
};

/**
 * A subagent progress row's text, as the reference client words it: the phase, then the
 * provider's subagent type in parentheses. The type is the only provider field it shows (never a
 * task description or summary, which can carry prompt text), single-line and capped.
 */
export function subagentProgressDetail(event: SubagentProgress): string {
  const type = collapseWhitespace((event.subagentType ?? "").replace(/[\x00-\x1f\x7f]/g, " "));
  const label = PHASE_LABEL[event.phase];
  return type ? `${label} (${truncateCodePointsWithEllipsis(type, 40)})` : label;
}

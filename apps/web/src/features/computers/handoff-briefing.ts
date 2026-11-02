import { truncateCodePointsWithEllipsis, type LocalSessionTurn } from "@lrm/coforge-sdk/internal";

import { finishedAgentUsername } from "#src/features/agents/agent-username";
import { DIRECT_MESSAGE_MAX_LENGTH } from "#src/features/conversations/conversation.schemas";
import { pathSegments } from "./local-session-list";

const FIRST_MESSAGE_MAX = 2_000;
const TURN_MAX = 800;
const RECENT_MAX = 3_500;
/** Shrink steps tried when the briefing with the full excerpt is still too long. */
const SHRINK_STEPS = [1, 0.5, 0.25, 0];

/** The Agent name a handoff starts with: the session's last folder in username form, else the tool's. */
export function defaultAgentName(cwd: string, toolLabel: string): string {
  return (
    finishedAgentUsername(pathSegments(cwd).at(-1) ?? "") ||
    finishedAgentUsername(toolLabel) ||
    "agent"
  );
}

/**
 * `name`, or the first of `name-2`, `name-3`… not in `taken` (lowercase handles), so a second
 * handoff from the same folder does not default to a name that is already an Agent's.
 */
export function freeAgentName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${name}-${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** `text` trimmed and cut to at most `max` code points, the ellipsis included. */
function clip(text: string, max: number): string {
  return max <= 0 ? "" : truncateCodePointsWithEllipsis(text.trim(), max - 1);
}

/** The opening request, else the session's title, else a dash. */
export function briefingFirstMessage(initialRequest: string | undefined, title: string): string {
  return initialRequest?.trim() || title.trim() || "-";
}

/** The newest turns that fit `budget` characters, oldest first, one `Role: text` block each. */
function formatRecentTurns(
  turns: readonly LocalSessionTurn[],
  roles: { user: string; assistant: string },
  turnMax: number,
  budget: number,
): string {
  const blocks: string[] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const text = clip(turn.text, turnMax);
    if (!text) continue;
    const block = `${roles[turn.role]}: ${text}`;
    if (used + block.length > budget) break;
    blocks.unshift(block);
    used += block.length + 2;
  }
  return blocks.join("\n\n") || "-";
}

/**
 * The briefing text, rendered by the localized template and kept within a message's length: the
 * opening request and the recent turns are cut to a budget, and the budget shrinks until the whole
 * text fits. The template's own text and the working directory are never cut.
 */
export function buildBriefing(input: {
  firstMessage: string;
  turns: readonly LocalSessionTurn[];
  roles: { user: string; assistant: string };
  render: (parts: { firstMessage: string; recent: string }) => string;
}): string {
  let text = "";
  for (const scale of SHRINK_STEPS) {
    text = input
      .render({
        firstMessage: clip(input.firstMessage, Math.floor(FIRST_MESSAGE_MAX * scale)) || "-",
        recent: formatRecentTurns(
          input.turns,
          input.roles,
          Math.floor(TURN_MAX * scale),
          Math.floor(RECENT_MAX * scale),
        ),
      })
      .trim();
    if (text.length <= DIRECT_MESSAGE_MAX_LENGTH) break;
  }
  return text;
}

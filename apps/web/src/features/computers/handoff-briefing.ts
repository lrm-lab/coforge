import { truncateCodePointsWithEllipsis, type LocalSessionTurn } from "@lrm/coforge-sdk/internal";

import { DIRECT_MESSAGE_MAX_LENGTH } from "#src/features/conversations/conversation.schemas";

const FIRST_MESSAGE_MAX = 2_000;
const TURN_MAX = 800;
const RECENT_MAX = 3_500;
/** Shrink steps tried when the briefing with the full excerpt is still too long. */
const SHRINK_STEPS = [1, 0.5, 0.25, 0];

/** `text` trimmed and cut to at most `max` code points, the ellipsis included. */
function clip(text: string, max: number): string {
  return max <= 0 ? "" : truncateCodePointsWithEllipsis(text.trim(), max - 1);
}

/** The opening request, else the session's title, else a dash. */
export function briefingFirstMessage(initialRequest: string | undefined, title: string): string {
  return initialRequest?.trim() || title.trim() || "-";
}

/** One turn as the briefing quotes it: who said it and the text, cut to the turn's limit. */
export type BriefingTurn = { role: LocalSessionTurn["role"]; text: string };

/** What the Agent is sent, and the quoted parts of it that the form shows on their own. */
export type Briefing = { text: string; firstMessage: string; turns: BriefingTurn[] };

/** The newest turns whose `Role: text` blocks fit `budget` characters, oldest first. */
function recentTurns(
  turns: readonly LocalSessionTurn[],
  roles: { user: string; assistant: string },
  turnMax: number,
  budget: number,
): BriefingTurn[] {
  const kept: BriefingTurn[] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const text = clip(turn.text, turnMax);
    if (!text) continue;
    const length = `${roles[turn.role]}: ${text}`.length;
    if (used + length > budget) break;
    kept.unshift({ role: turn.role, text });
    used += length + 2;
  }
  return kept;
}

/**
 * The briefing, rendered by the localized template and kept within a message's length: the
 * opening request and the recent turns are cut to a budget, and the budget shrinks until the whole
 * text fits. The template's own text and the working directory are never cut. The quoted parts
 * come back as sent, so what the form shows is what the Agent reads.
 */
export function buildBriefing(input: {
  firstMessage: string;
  turns: readonly LocalSessionTurn[];
  roles: { user: string; assistant: string };
  render: (parts: { firstMessage: string; recent: string }) => string;
}): Briefing {
  let briefing: Briefing = { text: "", firstMessage: "", turns: [] };
  for (const scale of SHRINK_STEPS) {
    const firstMessage = clip(input.firstMessage, Math.floor(FIRST_MESSAGE_MAX * scale)) || "-";
    const turns = recentTurns(
      input.turns,
      input.roles,
      Math.floor(TURN_MAX * scale),
      Math.floor(RECENT_MAX * scale),
    );
    const recent = turns.map((turn) => `${input.roles[turn.role]}: ${turn.text}`).join("\n\n");
    briefing = {
      text: input.render({ firstMessage, recent: recent || "-" }).trim(),
      firstMessage,
      turns,
    };
    if (briefing.text.length <= DIRECT_MESSAGE_MAX_LENGTH) break;
  }
  return briefing;
}

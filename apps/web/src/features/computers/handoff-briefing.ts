import {
  RUNTIME_PROVIDER,
  type HandoffRuntimeProvider,
  type LocalSessionEntry,
  type LocalSessionTurn,
} from "@lrm/coforge-sdk/internal";

import { finishedAgentUsername } from "#src/features/agents/agent-username";

/** The tools a local session can come from, in tab order. A handoff Agent runs the same runtime
 * the session came from: `HandoffRuntimeProvider` is a subset of `RuntimeProvider`, so the value
 * is the Agent's `provider` as it stands. */
export const HANDOFF_PROVIDERS: readonly HandoffRuntimeProvider[] = [
  RUNTIME_PROVIDER.CLAUDE_CODE,
  RUNTIME_PROVIDER.CODEX,
];

/** A session touched this recently may still be running on the Computer; the dialog warns, never blocks. */
const ACTIVE_WINDOW_MS = 5 * 60_000;

/** A direct message body is capped at 8,000 characters (`sendConversationMessageInputSchema`). */
export const BRIEFING_MAX_LENGTH = 8_000;
const FIRST_MESSAGE_MAX = 2_000;
const TURN_MAX = 800;
const RECENT_MAX = 3_500;
/** Shrink steps tried when the briefing with the full excerpt is still too long. */
const SHRINK_STEPS = [1, 0.5, 0.25, 0];

export function isRecentlyActive(updatedAtMs: number, nowMs: number): boolean {
  return nowMs - updatedAtMs < ACTIVE_WINDOW_MS;
}

/** The newest session first; the daemon's order is by relevance when a query matched content. */
export function sortSessions(sessions: readonly LocalSessionEntry[]): LocalSessionEntry[] {
  return [...sessions].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

export function sessionKey(session: Pick<LocalSessionEntry, "provider" | "sessionId">): string {
  return `${session.provider}:${session.sessionId}`;
}

export function sessionsByProvider(
  sessions: readonly LocalSessionEntry[],
  provider: HandoffRuntimeProvider,
): LocalSessionEntry[] {
  return sessions.filter((session) => session.provider === provider);
}

/** The tab a picker opens on: the tool of the newest session, else the first tool. */
export function defaultProvider(sessions: readonly LocalSessionEntry[]): HandoffRuntimeProvider {
  return sortSessions(sessions)[0]?.provider ?? HANDOFF_PROVIDERS[0]!;
}

/** The Computer a handoff starts on: the only one, else the first that is online, else the first. */
export function preferredComputerId(
  computers: readonly { id: string; online?: boolean }[],
): string | undefined {
  return (computers.find((computer) => computer.online) ?? computers[0])?.id;
}

function pathSegments(path: string): string[] {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0);
}

/** The last folder of a working directory, as written. */
export function lastFolder(cwd: string): string {
  return pathSegments(cwd).at(-1) ?? "";
}

/** The Agent name a handoff starts with: the session's folder in username form, else the tool's. */
export function defaultAgentName(cwd: string, toolLabel: string): string {
  return finishedAgentUsername(lastFolder(cwd)) || finishedAgentUsername(toolLabel) || "agent";
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

const HOME_PREFIX = /^(?:[A-Za-z]:)?\/(?:Users|home)\/[^/]+/;

/** A working directory for a list row: the home folder as `~`, and only the last two folders when
 * the path is longer than that. The full path stays in the form. */
export function shortenPath(path: string, keep = 2): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "").replace(HOME_PREFIX, "~");
  if (!normalized) return "/";
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length <= keep + 1) return normalized;
  return `…/${segments.slice(-keep).join("/")}`;
}

/** `text` trimmed to at most `max` characters, ending in an ellipsis when cut, never inside a surrogate pair. */
export function truncateText(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  if (max <= 0) return "";
  let end = max - 1;
  const last = trimmed.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${trimmed.slice(0, end).trimEnd()}…`;
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
    const text = truncateText(turn.text, turnMax);
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
        firstMessage:
          truncateText(input.firstMessage, Math.floor(FIRST_MESSAGE_MAX * scale)) || "-",
        recent: formatRecentTurns(
          input.turns,
          input.roles,
          Math.floor(TURN_MAX * scale),
          Math.floor(RECENT_MAX * scale),
        ),
      })
      .trim();
    if (text.length <= BRIEFING_MAX_LENGTH) break;
  }
  return text;
}

import {
  HANDOFF_RUNTIME_PROVIDERS,
  type HandoffRuntimeProvider,
  type LocalSessionEntry,
} from "@lrm/coforge-sdk/internal";

/** A session touched this recently may still be running on the Computer; the dialog warns, never blocks. */
const ACTIVE_WINDOW_MS = 5 * 60_000;

const HOME_PREFIX = /^(?:[A-Za-z]:)?\/(?:Users|home)\/[^/]+/;

export function isRecentlyActive(updatedAtMs: number, nowMs: number): boolean {
  return nowMs - updatedAtMs < ACTIVE_WINDOW_MS;
}

/** The newest session first. */
export function sortSessions(sessions: readonly LocalSessionEntry[]): LocalSessionEntry[] {
  return [...sessions].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

export function sessionKey(session: Pick<LocalSessionEntry, "provider" | "sessionId">): string {
  return `${session.provider}:${session.sessionId}`;
}

/** `sessions` split by tool in one pass, each list keeping the order given. */
export function sessionsByProvider(
  sessions: readonly LocalSessionEntry[],
): Record<HandoffRuntimeProvider, LocalSessionEntry[]> {
  const grouped = Object.fromEntries(
    HANDOFF_RUNTIME_PROVIDERS.map((provider) => [provider, [] as LocalSessionEntry[]]),
  ) as Record<HandoffRuntimeProvider, LocalSessionEntry[]>;
  for (const session of sessions) grouped[session.provider].push(session);
  return grouped;
}

/** The tab a picker opens on: the tool of the newest session (`sessions` is newest first), else the first tool. */
export function defaultProvider(sessions: readonly LocalSessionEntry[]): HandoffRuntimeProvider {
  return sessions[0]?.provider ?? HANDOFF_RUNTIME_PROVIDERS[0];
}

/** The folders of a path, in order, whichever separator it was written with. */
export function pathSegments(path: string): string[] {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0);
}

/** A working directory for a list row: the home folder as `~`, and only the last two folders when
 * the path is longer than that. The full path stays in the form. */
export function shortenPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "").replace(HOME_PREFIX, "~");
  if (!normalized) return "/";
  const segments = pathSegments(normalized);
  if (segments.length <= 3) return normalized;
  return `…/${segments.slice(-2).join("/")}`;
}

/** What a session's row in the list shows: its trimmed title (empty when it has
 * none) and where it ran, the shortened directory and the model. */
export function sessionSummary(session: LocalSessionEntry): { title: string; place: string } {
  return {
    title: session.title.trim(),
    place: [shortenPath(session.cwd), session.model].filter(Boolean).join(" · "),
  };
}

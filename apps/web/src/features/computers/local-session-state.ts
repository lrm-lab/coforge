import type {
  LocalSessionEntry,
  LocalSessionExcerptResult,
  LocalSessionSearchResult,
} from "@lrm/coforge-sdk/internal";

import type { LocalSessionResponse } from "#src/server/computers/computer-local-sessions.server";
import { sortSessions } from "./local-session-list";

export type SessionListState =
  | { kind: "loading" }
  | { kind: "ready"; sessions: LocalSessionEntry[]; incomplete: boolean }
  | { kind: "busy" | "offline" | "unsupported" };

type SessionExcerpt = Pick<LocalSessionExcerptResult, "model" | "initialRequest" | "recentTurns">;

export type SessionExcerptState =
  | { kind: "loading" }
  | { kind: "ready"; excerpt: SessionExcerpt }
  | { kind: "failed" | "busy" | "offline" | "unsupported" };

type SearchResult = Pick<
  LocalSessionSearchResult,
  "sessions" | "scanComplete" | "contentSearchComplete"
>;
type ExcerptResult = SessionExcerpt & Pick<LocalSessionExcerptResult, "status">;

type Refusal = { kind: "loading" | "busy" | "offline" | "unsupported" };

/**
 * What every answer shares: none yet is loading (busy once the call failed), an offline or
 * unsupported Computer is named, any other non-ready answer (a timeout, a daemon still scanning)
 * means the Computer is still reading, so it is busy and offers a retry. Only a ready answer
 * carries its result on to the caller.
 */
function triage<Result>(
  response: LocalSessionResponse<Result> | undefined,
  failed: boolean,
): Refusal | { kind: "ready"; result: Result } {
  if (!response) return { kind: failed ? "busy" : "loading" };
  if (response.status === "ready") return { kind: "ready", result: response.result };
  return {
    kind:
      response.status === "offline" || response.status === "unsupported" ? response.status : "busy",
  };
}

/**
 * The picker's state for a search, its sessions newest first. A timeout, a failed call, or an
 * empty list from a scan that did not finish all mean the Computer is still reading (its previous
 * scan may still be running after a timeout), so none of them may read as "no sessions": they
 * offer a retry.
 */
export function sessionListState(
  response: LocalSessionResponse<SearchResult> | undefined,
  failed: boolean,
): SessionListState {
  const answer = triage(response, failed);
  if (answer.kind !== "ready") return answer;
  const { sessions, scanComplete, contentSearchComplete } = answer.result;
  const incomplete = !scanComplete || !contentSearchComplete;
  if (sessions.length === 0 && incomplete) return { kind: "busy" };
  return { kind: "ready", sessions: sortSessions(sessions), incomplete };
}

/**
 * The form's state for one session's excerpt. `unavailable` is how a daemon that is still scanning
 * answers, and cannot be told from an unreadable session, so it offers a retry; only `not_found`
 * is a definite failure.
 */
export function sessionExcerptState(
  response: LocalSessionResponse<ExcerptResult> | undefined,
  failed: boolean,
): SessionExcerptState {
  const answer = triage(response, failed);
  if (answer.kind !== "ready") return answer;
  switch (answer.result.status) {
    case "ok": {
      const { model, initialRequest, recentTurns } = answer.result;
      return { kind: "ready", excerpt: { model, initialRequest, recentTurns } };
    }
    case "not_found":
      return { kind: "failed" };
    case "unavailable":
      return { kind: "busy" };
  }
}

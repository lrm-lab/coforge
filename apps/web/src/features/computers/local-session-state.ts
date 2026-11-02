import type {
  LocalSessionEntry,
  LocalSessionExcerptResult,
  LocalSessionSearchResult,
} from "@lrm/coforge-sdk/internal";

/** What the Computer's daemon answers, as the Server Functions pass it on. */
export type HandoffResponse<Result> =
  | { status: "ready"; result: Result }
  | { status: "offline" | "unsupported" | "timeout" | "unavailable" };

export type SessionListState =
  | { kind: "loading" }
  | { kind: "ready"; sessions: LocalSessionEntry[]; incomplete: boolean }
  | { kind: "busy" | "offline" | "unsupported" };

export type SessionExcerpt = Pick<
  LocalSessionExcerptResult,
  "model" | "initialRequest" | "recentTurns"
>;

export type SessionExcerptState =
  | { kind: "loading" }
  | { kind: "ready"; excerpt: SessionExcerpt }
  | { kind: "failed" | "busy" | "offline" | "unsupported" };

type SearchResult = Pick<
  LocalSessionSearchResult,
  "sessions" | "scanComplete" | "contentSearchComplete"
>;
type ExcerptResult = SessionExcerpt & Pick<LocalSessionExcerptResult, "status">;

/**
 * The picker's state for a search. A timeout, a failed call, or an empty list from a scan that did
 * not finish all mean the Computer is still reading (its previous scan may still be running after
 * a timeout), so none of them may read as "no sessions": they offer a retry.
 */
export function sessionListState(
  response: HandoffResponse<SearchResult> | undefined,
  failed: boolean,
): SessionListState {
  if (!response) return failed ? { kind: "busy" } : { kind: "loading" };
  if (response.status === "offline" || response.status === "unsupported")
    return { kind: response.status };
  if (response.status !== "ready") return { kind: "busy" };
  const { sessions, scanComplete, contentSearchComplete } = response.result;
  const incomplete = !scanComplete || !contentSearchComplete;
  if (sessions.length === 0 && incomplete) return { kind: "busy" };
  return { kind: "ready", sessions, incomplete };
}

/**
 * The form's state for one session's excerpt. `unavailable` is how a daemon that is still scanning
 * answers, and cannot be told from an unreadable session, so it offers a retry; only `not_found`
 * is a definite failure.
 */
export function sessionExcerptState(
  response: HandoffResponse<ExcerptResult> | undefined,
  failed: boolean,
): SessionExcerptState {
  if (!response) return failed ? { kind: "busy" } : { kind: "loading" };
  if (response.status === "offline" || response.status === "unsupported")
    return { kind: response.status };
  if (response.status !== "ready") return { kind: "busy" };
  switch (response.result.status) {
    case "ok": {
      const { model, initialRequest, recentTurns } = response.result;
      return { kind: "ready", excerpt: { model, initialRequest, recentTurns } };
    }
    case "not_found":
      return { kind: "failed" };
    case "unavailable":
      return { kind: "busy" };
  }
}

import { describe, expect, test } from "bun:test";
import { RUNTIME_PROVIDER, type LocalSessionEntry } from "@lrm/coforge-sdk/internal";

import { sessionExcerptState, sessionListState } from "./local-session-state";

type Response<Read extends (response: never, failed: boolean) => unknown> = NonNullable<
  Parameters<Read>[0]
>;

const session: LocalSessionEntry = {
  provider: RUNTIME_PROVIDER.CODEX,
  sessionId: "s1",
  cwd: "/tmp/app",
  model: "",
  title: "t",
  updatedAtMs: 1,
  matchKind: "recent",
  snippet: "",
};
const search = (
  sessions: LocalSessionEntry[],
  scanComplete: boolean,
  contentSearchComplete: boolean,
) => ({ status: "ready", result: { sessions, scanComplete, contentSearchComplete } }) as const;

describe("sessionListState", () => {
  test("waits for the first answer, and calls a failed one busy", () => {
    expect(sessionListState(undefined, false)).toEqual({ kind: "loading" });
    expect(sessionListState(undefined, true)).toEqual({ kind: "busy" });
  });
  test("names a Computer that is offline or too old", () => {
    expect(sessionListState({ status: "offline" }, false)).toEqual({ kind: "offline" });
    expect(sessionListState({ status: "unsupported" }, false)).toEqual({ kind: "unsupported" });
  });
  test("treats a timeout or an unavailable Computer as still reading", () => {
    expect(sessionListState({ status: "timeout" }, false)).toEqual({ kind: "busy" });
    expect(sessionListState({ status: "unavailable" }, false)).toEqual({ kind: "busy" });
  });
  test("never reads an unfinished empty list as no sessions", () => {
    expect(sessionListState(search([], false, true), false)).toEqual({ kind: "busy" });
    expect(sessionListState(search([], true, false), false)).toEqual({ kind: "busy" });
  });
  test("an empty list from a finished scan is empty", () => {
    expect(sessionListState(search([], true, true), false)).toEqual({
      kind: "ready",
      sessions: [],
      incomplete: false,
    });
  });
  test("lists the newest session first", () => {
    const older = { ...session, sessionId: "old", updatedAtMs: 1 };
    const newer = { ...session, sessionId: "new", updatedAtMs: 5 };
    const state = sessionListState(search([older, newer], true, true), false);
    expect(state.kind === "ready" && state.sessions.map((s) => s.sessionId)).toEqual([
      "new",
      "old",
    ]);
  });
  test("a partial list is shown and marked incomplete", () => {
    expect(sessionListState(search([session], true, false), false)).toEqual({
      kind: "ready",
      sessions: [session],
      incomplete: true,
    });
  });
});

describe("sessionExcerptState", () => {
  const excerpt = (
    status: "ok" | "not_found" | "unavailable",
  ): Response<typeof sessionExcerptState> => ({
    status: "ready",
    result: { status, model: "m", initialRequest: "go", recentTurns: [] },
  });

  test("an ok excerpt is ready", () => {
    expect(sessionExcerptState(excerpt("ok"), false)).toEqual({
      kind: "ready",
      excerpt: { model: "m", initialRequest: "go", recentTurns: [] },
    });
  });
  test("only not_found is a definite failure", () => {
    expect(sessionExcerptState(excerpt("not_found"), false)).toEqual({ kind: "failed" });
  });
  test("unavailable, a timeout and a failed call all offer a retry", () => {
    expect(sessionExcerptState(excerpt("unavailable"), false)).toEqual({ kind: "busy" });
    expect(sessionExcerptState({ status: "timeout" }, false)).toEqual({ kind: "busy" });
    expect(sessionExcerptState({ status: "unavailable" }, false)).toEqual({ kind: "busy" });
    expect(sessionExcerptState(undefined, true)).toEqual({ kind: "busy" });
  });
  test("loads until answered, and names an offline or old Computer", () => {
    expect(sessionExcerptState(undefined, false)).toEqual({ kind: "loading" });
    expect(sessionExcerptState({ status: "offline" }, false)).toEqual({ kind: "offline" });
    expect(sessionExcerptState({ status: "unsupported" }, false)).toEqual({ kind: "unsupported" });
  });
});

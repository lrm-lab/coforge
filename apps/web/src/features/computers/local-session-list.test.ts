import { describe, expect, test } from "bun:test";
import { RUNTIME_PROVIDER, type LocalSessionEntry } from "@lrm/coforge-sdk/internal";

import {
  defaultProvider,
  isRecentlyActive,
  sessionKey,
  sessionSummary,
  sessionsByProvider,
  shortenPath,
  sortSessions,
} from "./local-session-list";

function entry(over: Partial<LocalSessionEntry>): LocalSessionEntry {
  return {
    provider: RUNTIME_PROVIDER.CLAUDE_CODE,
    sessionId: "s1",
    cwd: "/Users/frank/Code/app",
    model: "",
    title: "",
    updatedAtMs: 0,
    matchKind: "recent",
    snippet: "",
    ...over,
  };
}

describe("isRecentlyActive", () => {
  const now = 10_000_000;
  test("is active inside five minutes, idle from five minutes on", () => {
    expect(isRecentlyActive(now - 4 * 60_000, now)).toBe(true);
    expect(isRecentlyActive(now - 5 * 60_000, now)).toBe(false);
    expect(isRecentlyActive(now - 60 * 60_000, now)).toBe(false);
  });
  test("treats a timestamp ahead of the clock as active", () => {
    expect(isRecentlyActive(now + 30_000, now)).toBe(true);
  });
});

describe("shortenPath", () => {
  test("shows the home folder as ~", () => {
    expect(shortenPath("/Users/frank")).toBe("~");
    expect(shortenPath("/home/frank/app")).toBe("~/app");
    expect(shortenPath("C:\\Users\\frank\\app")).toBe("~/app");
  });
  test("keeps the last two folders of a long path", () => {
    expect(shortenPath("/Users/frank/Code/coforge/apps/web")).toBe("…/apps/web");
    expect(shortenPath("/var/lib/app")).toBe("/var/lib/app");
    expect(shortenPath("/srv/a/b/c")).toBe("…/b/c");
  });
  test("keeps a short path whole", () => {
    expect(shortenPath("/")).toBe("/");
    expect(shortenPath("/tmp/")).toBe("/tmp");
  });
});

describe("sessions", () => {
  test("sorts the newest first without touching the input", () => {
    const input = [
      entry({ sessionId: "a", updatedAtMs: 1 }),
      entry({ sessionId: "b", updatedAtMs: 3 }),
    ];
    expect(sortSessions(input).map((s) => s.sessionId)).toEqual(["b", "a"]);
    expect(input[0]!.sessionId).toBe("a");
  });
  test("opens on the tool of the newest session, else Claude Code", () => {
    expect(
      defaultProvider([
        entry({ provider: RUNTIME_PROVIDER.CODEX, sessionId: "c", updatedAtMs: 2 }),
        entry({ updatedAtMs: 1 }),
      ]),
    ).toBe(RUNTIME_PROVIDER.CODEX);
    expect(defaultProvider([])).toBe(RUNTIME_PROVIDER.CLAUDE_CODE);
  });
  test("splits by tool in one pass, keeping each tool's order", () => {
    const grouped = sessionsByProvider([
      entry({ sessionId: "a" }),
      entry({ provider: RUNTIME_PROVIDER.CODEX, sessionId: "b" }),
      entry({ sessionId: "c" }),
    ]);
    expect(grouped[RUNTIME_PROVIDER.CLAUDE_CODE].map((s) => s.sessionId)).toEqual(["a", "c"]);
    expect(grouped[RUNTIME_PROVIDER.CODEX].map((s) => s.sessionId)).toEqual(["b"]);
    expect(sessionsByProvider([])[RUNTIME_PROVIDER.CODEX]).toEqual([]);
  });
  test("keys a session by tool and id", () => {
    expect(sessionKey(entry({ provider: RUNTIME_PROVIDER.CODEX, sessionId: "x" }))).toBe(
      `${RUNTIME_PROVIDER.CODEX}:x`,
    );
  });
});

describe("sessionSummary", () => {
  test("is the trimmed title and the shortened directory with the model", () => {
    expect(
      sessionSummary(entry({ title: " Fix it ", cwd: "/home/frank/app", model: "opus" })),
    ).toEqual({ title: "Fix it", place: "~/app · opus" });
  });
  test("leaves an untitled session's title empty and drops a missing model", () => {
    expect(sessionSummary(entry({ title: "  " }))).toEqual({ title: "", place: "~/Code/app" });
  });
});

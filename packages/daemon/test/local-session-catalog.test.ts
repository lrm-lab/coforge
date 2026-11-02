import { expect, test } from "bun:test";
import { LocalSessionCatalog } from "#src/local-session/local-session-catalog";

const native = (sessionId: string, updatedAtMs: number) => ({
  sessionId,
  cwd: `/work/${sessionId}`,
  model: "model",
  title: sessionId,
  updatedAtMs,
  matchKind: "recent" as const,
  snippet: "",
});

test("catalog merges providers by recency and preserves incomplete search flags", async () => {
  const catalog = new LocalSessionCatalog({
    claude: {
      search: async () => ({
        sessions: [native("claude-old", 1)],
        scanComplete: true,
        contentSearchComplete: false,
      }),
      excerpt: async () => undefined,
    },
    codex: {
      search: async () => ({
        sessions: [native("codex-new", 2)],
        scanComplete: false,
        contentSearchComplete: true,
      }),
      excerpt: async () => undefined,
    },
    now: () => 0,
  });
  expect(await catalog.search("needle")).toEqual({
    sessions: [
      expect.objectContaining({ provider: "codex", sessionId: "codex-new" }),
      expect.objectContaining({ provider: "claude-code", sessionId: "claude-old" }),
    ],
    scanComplete: false,
    contentSearchComplete: false,
  });
});

test("excerpt returns unavailable without leaking errors and fits the wire text budget", async () => {
  const catalog = new LocalSessionCatalog({
    claude: {
      search: async () => ({ sessions: [], scanComplete: true, contentSearchComplete: true }),
      excerpt: async () => ({
        model: "claude-sonnet-4-5",
        updatedAtMs: 3,
        initialRequest: "初".repeat(10_000),
        recentTurns: Array.from({ length: 20 }, (_, index) => ({
          role: index % 2 ? ("assistant" as const) : ("user" as const),
          text: "答".repeat(10_000),
          timestampMs: index,
        })),
      }),
    },
    codex: {
      search: async () => ({ sessions: [], scanComplete: true, contentSearchComplete: true }),
      excerpt: async () => {
        throw new Error("private path");
      },
    },
    now: () => 0,
  });
  const ready = await catalog.excerpt("claude-code", "session", "/work/session");
  expect(ready.status).toBe("ok");
  expect(
    new TextEncoder().encode(
      ready.initialRequest + ready.recentTurns.map((turn) => turn.text).join(""),
    ).byteLength,
  ).toBeLessThanOrEqual(24 * 1024);
  expect(await catalog.excerpt("codex", "session", "/work/session")).toEqual({
    status: "unavailable",
    model: "",
    updatedAtMs: 0,
    initialRequest: "",
    recentTurns: [],
  });
});

test("cross-provider result truncation is reported as incomplete", async () => {
  const sessions = (prefix: string, from: number) =>
    Array.from({ length: 60 }, (_, index) => native(`${prefix}-${index}`, from + index));
  const catalog = new LocalSessionCatalog({
    claude: {
      search: async () => ({
        sessions: sessions("claude", 0),
        scanComplete: true,
        contentSearchComplete: true,
      }),
      excerpt: async () => undefined,
    },
    codex: {
      search: async () => ({
        sessions: sessions("codex", 100),
        scanComplete: true,
        contentSearchComplete: true,
      }),
      excerpt: async () => undefined,
    },
    now: () => 0,
  });
  const result = await catalog.search("match");
  expect(result.sessions).toHaveLength(100);
  expect(result.scanComplete).toBeFalse();
  expect(result.contentSearchComplete).toBeFalse();
});

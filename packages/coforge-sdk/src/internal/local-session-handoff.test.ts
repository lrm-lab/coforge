import { expect, test } from "bun:test";
import {
  decodeLocalSessionExcerptRequest,
  decodeLocalSessionExcerptResult,
  decodeLocalSessionSearchRequest,
  decodeLocalSessionSearchResult,
  encodeLocalSessionExcerptRequest,
  encodeLocalSessionExcerptResult,
  encodeLocalSessionSearchRequest,
  encodeLocalSessionSearchResult,
  LOCAL_SESSION_HANDOFF_CAPABILITY,
} from "./local-session-handoff";

const scope = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
};

test("local session search round trips bounded session metadata", () => {
  const request = { ...scope, query: "unfinished" };
  expect(decodeLocalSessionSearchRequest(encodeLocalSessionSearchRequest(request))).toEqual(
    request,
  );
  const result = {
    ...request,
    sessions: [
      {
        provider: "claude-code" as const,
        sessionId: "session-1",
        cwd: "/work/project",
        model: "claude-sonnet-4-5",
        title: "Fix the importer",
        updatedAtMs: 10,
        matchKind: "content" as const,
        snippet: "unfinished importer",
      },
    ],
    scanComplete: true,
    contentSearchComplete: false,
  };
  expect(decodeLocalSessionSearchResult(encodeLocalSessionSearchResult(result))).toEqual(result);
  expect(LOCAL_SESSION_HANDOFF_CAPABILITY).toBe("local-session-handoff:v1");
});

test("local session excerpt round trips only briefing text", () => {
  const request = {
    ...scope,
    provider: "codex" as const,
    sessionId: "11111111-2222-4333-8444-555555555555",
    cwd: "/work/project",
  };
  expect(decodeLocalSessionExcerptRequest(encodeLocalSessionExcerptRequest(request))).toEqual(
    request,
  );
  const result = {
    ...request,
    status: "ok" as const,
    model: "gpt-5.3-codex",
    updatedAtMs: 20,
    initialRequest: "Repair the parser",
    recentTurns: [
      { role: "user" as const, text: "Continue the repair", timestampMs: 18 },
      { role: "assistant" as const, text: "I changed the tokenizer", timestampMs: 20 },
    ],
  };
  expect(decodeLocalSessionExcerptResult(encodeLocalSessionExcerptResult(result))).toEqual(result);
});

test("local session codecs reject oversized or unsafe values", () => {
  expect(() => encodeLocalSessionSearchRequest({ ...scope, query: "x".repeat(201) })).toThrow();
  expect(() =>
    encodeLocalSessionExcerptRequest({
      ...scope,
      provider: "pi" as "codex",
      sessionId: "session-1",
      cwd: "/work",
    }),
  ).toThrow();
  expect(() =>
    encodeLocalSessionExcerptResult({
      ...scope,
      provider: "codex",
      sessionId: "session-1",
      cwd: "/work",
      status: "ok",
      model: "",
      updatedAtMs: 1,
      initialRequest: "",
      recentTurns: Array.from({ length: 13 }, () => ({
        role: "user" as const,
        text: "x",
        timestampMs: 1,
      })),
    }),
  ).toThrow();
});

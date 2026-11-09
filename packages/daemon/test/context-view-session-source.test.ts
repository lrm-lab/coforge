import { expect, test } from "bun:test";
import { contextViewTranscriptSource } from "#src/agent-context-view/context-view-session-source";

test("resolves built-in and Pi session manager transcript files under the workspace", () => {
  const source = contextViewTranscriptSource(
    { sessionManager: { getSessionFile: () => "/workspace/.builtin-sessions/session.jsonl" } },
    "/workspace",
  );
  expect(source).toEqual({
    absolute: "/workspace/.builtin-sessions/session.jsonl",
    relative: ".builtin-sessions/session.jsonl",
  });
});

test("rejects native transcript files outside the Agent workspace", () => {
  expect(
    contextViewTranscriptSource(
      { sessionFile: "/Users/frank/.claude/session.jsonl" },
      "/workspace",
    ),
  ).toBeUndefined();
});

import { expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  findProviderTranscript,
  resolveProviderTranscriptToken,
} from "#src/agent-context-view/context-view-provider-locator";

test("resolves stable provider-relative Claude and Codex tokens", () => {
  expect(
    resolveProviderTranscriptToken(
      RUNTIME_PROVIDER.CLAUDE_CODE,
      `${RUNTIME_PROVIDER.CLAUDE_CODE}:projects/work/session.jsonl`,
      { CLAUDE_CONFIG_DIR: "/tmp/claude" },
    ),
  ).toBe("/tmp/claude/projects/work/session.jsonl");
  expect(
    resolveProviderTranscriptToken("codex", "codex:sessions/2026/11/09/rollout.jsonl", {
      CODEX_HOME: "/tmp/codex",
    }),
  ).toBe("/tmp/codex/sessions/2026/11/09/rollout.jsonl");
});

test("rejects provider token traversal and cross-provider tokens", () => {
  expect(
    resolveProviderTranscriptToken(RUNTIME_PROVIDER.CLAUDE_CODE, "codex:../secret", {
      CLAUDE_CONFIG_DIR: "/tmp/claude",
    }),
  ).toBeUndefined();
  expect(
    resolveProviderTranscriptToken(
      RUNTIME_PROVIDER.CLAUDE_CODE,
      `${RUNTIME_PROVIDER.CLAUDE_CODE}:../secret`,
      { CLAUDE_CONFIG_DIR: "/tmp/claude" },
    ),
  ).toBeUndefined();
});

test("resolves a root-relative Kimi session index entry", async () => {
  const root = mkdtempSync(join("/tmp", "kimi-context-"));
  const sessionDir = join(root, "sessions", "relative-session");
  mkdirSync(join(sessionDir, "agents", "main"), { recursive: true });
  writeFileSync(join(sessionDir, "agents", "main", "wire.jsonl"), "{}\n");
  writeFileSync(
    join(root, "session_index.jsonl"),
    JSON.stringify({ session_id: "relative-session", session_dir: "sessions/relative-session" }) +
      "\n",
  );
  const source = await findProviderTranscript("kimi-sdk", "relative-session", {
    KIMI_CODE_HOME: root,
  });
  expect(source?.relative).toBe("kimi-sdk:sessions/relative-session/agents/main/wire.jsonl");
});

test("does not resurrect a Kimi session tombstoned in session_index.jsonl", async () => {
  const root = mkdtempSync(join("/tmp", "kimi-context-"));
  const sessionDir = join(root, "sessions", "2026-11-09", "session-1");
  mkdirSync(join(sessionDir, "agents", "main"), { recursive: true });
  writeFileSync(join(sessionDir, "agents", "main", "wire.jsonl"), "{}\n");
  writeFileSync(
    join(root, "session_index.jsonl"),
    JSON.stringify({ sessionId: "session-1", sessionDir, deleted: true }) + "\n",
  );
  expect(
    await findProviderTranscript("kimi-sdk", "session-1", { KIMI_CODE_HOME: root }),
  ).toBeUndefined();
});

test("captured providers do not expose an external transcript", async () => {
  expect(await findProviderTranscript(RUNTIME_PROVIDER.PI, "session-1", {})).toBeUndefined();
  expect(await findProviderTranscript(RUNTIME_PROVIDER.COFORGE, "session-1", {})).toBeUndefined();
});

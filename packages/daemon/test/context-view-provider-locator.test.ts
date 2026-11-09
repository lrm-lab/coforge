import { expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
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

test("only the providers that keep their own transcript have one to find", async () => {
  // task #739: this used to look for a Kimi session under KIMI_CODE_HOME, but no RuntimeProvider
  // ever launches one — the reader was copied from Raft, which has a kimi-sdk runtime.
  expect(await findProviderTranscript("kimi-sdk", "session-1", {})).toBeUndefined();
  expect(await findProviderTranscript(RUNTIME_PROVIDER.PI, "session-1", {})).toBeUndefined();
  expect(await findProviderTranscript(RUNTIME_PROVIDER.COFORGE, "session-1", {})).toBeUndefined();
});

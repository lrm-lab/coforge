import { expect, test } from "bun:test";
import { ClaudeCodeProvider, type ClaudeQuotaObservation } from "@lrm/coforge-anvil/claude-code";
import { tmpdir } from "node:os";
import { claudeEventFeed, TEST_AGENT_INSTRUCTIONS } from "./fixtures/claude-feed";
import { fixtureClaudeHost } from "./fixtures/claude-host";

test("observes private, launch-scoped quota facts ahead of normalization", async () => {
  const feed = claudeEventFeed();
  const observations: ClaudeQuotaObservation[] = [];
  const provider = new ClaudeCodeProvider({
    host: fixtureClaudeHost,
    command: [
      process.execPath,
      new URL("./fixtures/claude-stream-json.ts", import.meta.url).pathname,
    ],
    quotaObservation: {
      runtimeId: "approved-runtime",
      observe: (observation) => observations.push(observation),
    },
  });
  const session = await provider.createAgentSession({
    runtimeId: "approved-runtime",
    agentWorkspaceDirectory: tmpdir(),
    instructions: TEST_AGENT_INSTRUCTIONS,
    environment: feed.environment,
  });
  try {
    feed.attach(session);
    await session.sendMessage("start synthetic turn");
    const sessionId = await feed.sessionId();
    const resetsAt = 1_900_000_000;
    const rate = (status: string, rateLimitType = "seven_day_fable") => ({
      type: "rate_limit_event",
      session_id: sessionId,
      parent_tool_use_id: null,
      rate_limit_info: { status, rateLimitType, resetsAt, account: "synthetic-private" },
    });
    const assistantError = {
      type: "assistant",
      session_id: sessionId,
      parent_tool_use_id: null,
      error: "rate_limit",
      message: { content: [{ type: "text", text: "API Error: 429 synthetic-private" }] },
    };
    await feed.emit(
      { ...rate("rejected"), session_id: "different-session" },
      { ...rate("rejected"), parent_tool_use_id: "child" },
      { ...rate("rejected"), agent_id: "child" },
      assistantError,
      rate("rejected"),
      rate("rejected"),
      rate("allowed"),
      rate("rejected"),
      { ...assistantError, session_id: "different-session" },
      assistantError,
      rate("allowed_warning", "seven_day"),
      rate("rejected", "synthetic-private@example.invalid"),
    );
    const reset = new Date(resetsAt * 1000).toISOString();
    expect(
      observations.map(({ observedAt, ...fact }) => {
        expect(Number.isFinite(Date.parse(observedAt))).toBe(true);
        return fact;
      }),
    ).toStrictEqual([
      { type: "rate_limit_error", afterWindowRejection: false },
      { type: "quota_window", status: "rejected", window: "seven_day_fable", resetsAt: reset },
      { type: "quota_window", status: "allowed", window: "seven_day_fable", resetsAt: reset },
      { type: "quota_window", status: "rejected", window: "seven_day_fable", resetsAt: reset },
      { type: "rate_limit_error", afterWindowRejection: true },
      { type: "quota_window", status: "allowed_warning", window: "seven_day", resetsAt: reset },
      { type: "quota_window", status: "rejected", window: "unknown", resetsAt: reset },
    ]);
  } finally {
    await session.dispose();
    feed.stop();
  }
});

test("requires the exact opt-in and uses it at most once", async () => {
  const observations: ClaudeQuotaObservation[] = [];
  const provider = new ClaudeCodeProvider({
    host: fixtureClaudeHost,
    command: [
      process.execPath,
      new URL("./fixtures/claude-stream-json.ts", import.meta.url).pathname,
    ],
    quotaObservation: {
      runtimeId: "approved-runtime",
      observe: (observation) => observations.push(observation),
    },
  });
  for (const [runtimeId, observed] of [
    [undefined, 0],
    ["other-runtime", 0],
    ["approved-runtime", 1],
    ["approved-runtime", 1],
  ] as const) {
    const feed = claudeEventFeed();
    try {
      const session = await provider.createAgentSession({
        runtimeId,
        agentWorkspaceDirectory: tmpdir(),
        instructions: TEST_AGENT_INSTRUCTIONS,
        environment: feed.environment,
      });
      try {
        feed.attach(session);
        await session.sendMessage("start synthetic turn");
        await feed.emit({
          type: "rate_limit_event",
          session_id: await feed.sessionId(),
          rate_limit_info: { status: "rejected", rateLimitType: "seven_day" },
        });
        expect(observations).toHaveLength(observed);
      } finally {
        await session.dispose();
      }
    } finally {
      feed.stop();
    }
  }
});

import { expect, test } from "bun:test";
import {
  RuntimeSessionNeedsResetError,
  assertSessionNotSpent,
  compactionFailuresStickToSession,
} from "#src/daemon-runtime/session-reset-guard";
import { captureDaemonLogs } from "./log-capture";

test("Pi's compaction failures stick to the session; the other runtimes' do not", () => {
  // Raft: PiDriver.session.compactionFailure = "sticks_to_session"; the other drivers "does_not_stick".
  expect(compactionFailuresStickToSession("pi")).toBe(true);
  expect(compactionFailuresStickToSession("coforge")).toBe(true);
  for (const provider of [
    "claude-code",
    "codex",
    "cursor",
    "grok",
    "kiro",
    "opencode",
    "antigravity",
    "dsh",
    "command-code",
    "devin",
    "future-runtime",
  ])
    expect(compactionFailuresStickToSession(provider), provider).toBe(false);
});

test("a spent Pi session is refused for resume, and says so in the log", async () => {
  const { records } = await captureDaemonLogs(async () => {
    expect(() =>
      assertSessionNotSpent({ agentId: "agent-a", provider: "pi", needsReset: true }),
    ).toThrow(RuntimeSessionNeedsResetError);
  });
  expect(
    records.find((record) => record.properties.event === "daemon.agent.start.session_needs_reset")
      ?.properties,
  ).toMatchObject({ agent_id: "agent-a", provider: "pi" });
});

test("a spent session on a runtime that does not stick is resumed, and a healthy Pi session too", () => {
  expect(() =>
    assertSessionNotSpent({ agentId: "agent-a", provider: "cursor", needsReset: true }),
  ).not.toThrow();
  expect(() =>
    assertSessionNotSpent({ agentId: "agent-a", provider: "pi", needsReset: false }),
  ).not.toThrow();
});

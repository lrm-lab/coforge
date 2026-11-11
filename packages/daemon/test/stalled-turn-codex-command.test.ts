import { expect, jest, test } from "bun:test";
import type { AgentRuntimeEvent, CodeAgentProvider } from "@lrm/coforge-anvil";
import { TRAJECTORY_QUIET_WINDOW_MS } from "#src/agent-runtime/activity-trajectory";
import { STALLED_TURN_SILENCE_MS } from "#src/daemon-runtime/stalled-turn-indicator";
import { activityHarness } from "./fixtures/activity-runtime";

// Codex's real sequence for a command that outlives its window (task #41, s144 0.1.29-dev.1): the
// session reports the command's `tool-start` while it does not yet accept the turn, the turn is
// adopted a moment later, and then the provider says nothing at all for fifteen minutes. The
// daemon knew the call was open (it reported it unfinished when the turn was interrupted), but the
// ten-minute tool window never fired: the tool-start itself was read as "the turn has ended"
// because `hasLiveTurn` had not flipped yet, which disarmed the watchdog the event should have
// armed.

const connection = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: `/tmp/coforge-stalled-codex-command-${crypto.randomUUID()}`,
};

function codexSession(
  live: () => boolean,
  onListener: (next: (event: AgentRuntimeEvent) => void) => void,
) {
  return {
    get hasLiveTurn() {
      return live();
    },
    async sendMessage() {},
    subscribe(next: (event: AgentRuntimeEvent) => void) {
      onListener(next);
      return () => undefined;
    },
    async interrupt() {},
    onExit() {
      return () => undefined;
    },
    async dispose() {},
  };
}

test("a command whose turn is not accepted yet is still watched", async () => {
  let live = true;
  let deliver: ((event: AgentRuntimeEvent) => void) | undefined;
  const provider: CodeAgentProvider = {
    provider: "codex",
    async createAgentSession() {
      return codexSession(
        () => live,
        (next) => {
          deliver = next;
        },
      );
    },
  };
  jest.useFakeTimers();
  const { runtime, activities } = await activityHarness(connection, provider);
  try {
    expect(deliver).toBeDefined();
    // The command starts and its own frame is observed while the turn is live.
    deliver!({
      type: "tool-start",
      id: "exec-8ed9c3f4",
      name: "bash",
      input: { command: "sleep 1500" },
    });
    // A second frame is still coalescing when the session reports the turn over: Codex's
    // `turn/completed` can land between a command and the output that follows it. Observed then,
    // that trailing frame used to read as the turn's end and disarm the command's watchdog — and a
    // provider that says nothing afterwards left the command unwatched for fifteen minutes
    // (task #41, s144).
    deliver!({ type: "thinking-delta", text: "Let me watch that command." });
    live = false;
    jest.advanceTimersByTime(TRAJECTORY_QUIET_WINDOW_MS);
    // The turn is live again, and the provider says nothing more for the rest of the window.
    live = true;
    activities.length = 0;
    jest.advanceTimersByTime(STALLED_TURN_SILENCE_MS - 60_000);
    expect(activities.filter((activity) => activity.detailKind === "runtime_stalled")).toEqual([]);
    jest.advanceTimersByTime(60_000);
    expect(activities.filter((activity) => activity.detailKind === "runtime_stalled")).toEqual([
      expect.objectContaining({ detailKind: "runtime_stalled", level: "error" }),
    ]);
  } finally {
    jest.useRealTimers();
    await runtime.stop();
  }
});

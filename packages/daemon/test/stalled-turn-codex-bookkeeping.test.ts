import { expect, jest, test } from "bun:test";
import type { AgentRuntimeEvent, CodeAgentProvider } from "@lrm/coforge-anvil";
import {
  STALLED_TURN_MODEL_SILENCE_MS,
  STALLED_TURN_SILENCE_MS,
} from "#src/daemon-runtime/stalled-turn-indicator";
import { activityHarness } from "./fixtures/activity-runtime";

// Codex's real sequence for a command that outlives its window, recorded from `codex-cli 0.167.0`
// running `sleep 900` (task #41, s144 0.1.30-dev.2). After the command starts, the provider keeps
// sending its own bookkeeping — a `session` identity frame that still reports no live turn, a
// `context-usage` reading — and then says nothing for the rest of the wait. Those frames are not
// the turn: reading one as its end cancelled the watchdog, and reading one as progress restarted
// its window, so the ten-minute tool window never fired on a real machine.

const connection = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: `/tmp/coforge-stalled-codex-bookkeeping-${crypto.randomUUID()}`,
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

/** Boots the harness with a Codex-shaped session the test drives frame by frame. */
async function codexHarness() {
  const state = { live: false };
  let deliver: ((event: AgentRuntimeEvent) => void) | undefined;
  const provider: CodeAgentProvider = {
    provider: "codex",
    async createAgentSession() {
      return codexSession(
        () => state.live,
        (next) => {
          deliver = next;
        },
      );
    },
  };
  const { runtime, activities } = await activityHarness(connection, provider);
  const send = (event: AgentRuntimeEvent) => deliver!(event);
  return { runtime, activities, send, state };
}

function stalls(activities: readonly { detailKind: string }[]) {
  return activities.filter((activity) => activity.detailKind === "runtime_stalled");
}

test("the command's own start is what the tool window counts from, and its bookkeeping is not the turn", async () => {
  jest.useFakeTimers();
  const { runtime, activities, send, state } = await codexHarness();
  try {
    // As recorded: the session's first identity frame arrives before the turn is accepted.
    send({ type: "session", identity: { sessionId: "01a1cce2-6a82", state: "unknown" } });
    state.live = true;
    send({ type: "session", identity: { sessionId: "01a1cce2-6a82", state: "resumable" } });
    send({ type: "thinking-delta", text: "**Planning delayed command execution**" });
    send({ type: "progress", source: "codex_agent_message_non_final" });
    send({
      type: "tool-start",
      id: "exec-fa757489",
      name: "bash",
      input: { command: "sleep 900" },
    });
    // Mid-command bookkeeping: a context reading and a session frame that still reads as no live
    // turn. Neither may cancel the clock or restart its window.
    send({ type: "context-usage", usedTokens: 15_599, windowTokens: 475_000 });
    state.live = false;
    send({ type: "session", identity: { sessionId: "01a1cce2-6a82", state: "resumable" } });
    state.live = true;
    activities.length = 0;
    // Nothing else arrives for the whole wait: the tool window is judged from the command's start.
    jest.advanceTimersByTime(STALLED_TURN_SILENCE_MS - 60_000);
    expect(stalls(activities)).toEqual([]);
    jest.advanceTimersByTime(60_000);
    expect(stalls(activities)).toEqual([
      expect.objectContaining({ detailKind: "runtime_stalled", level: "error" }),
    ]);
  } finally {
    jest.useRealTimers();
    await runtime.stop();
  }
});

test("a context reading alone does not restart a silent turn's window", async () => {
  jest.useFakeTimers();
  const { runtime, activities, send, state } = await codexHarness();
  try {
    state.live = true;
    send({ type: "session", identity: { sessionId: "01a1cce2-6a82", state: "resumable" } });
    send({ type: "tool-start", id: "exec-1", name: "bash", input: { command: "sleep 900" } });
    activities.length = 0;
    // Nine silent minutes, then the only frame the provider sends: a token reading.
    jest.advanceTimersByTime(STALLED_TURN_SILENCE_MS - 60_000);
    send({ type: "context-usage", usedTokens: 15_853, windowTokens: 475_000 });
    expect(stalls(activities)).toEqual([]);
    // The window is still the command's: it fires a minute later, not nineteen.
    jest.advanceTimersByTime(60_000);
    expect(stalls(activities)).toHaveLength(1);
  } finally {
    jest.useRealTimers();
    await runtime.stop();
  }
});

test("a turn with no open tool is judged on the model window, which bookkeeping does not push out", async () => {
  jest.useFakeTimers();
  const { runtime, activities, send, state } = await codexHarness();
  try {
    state.live = true;
    send({ type: "session", identity: { sessionId: "01a1cce2-6a82", state: "resumable" } });
    send({ type: "thinking-delta", text: "Let me wait for that." });
    activities.length = 0;
    jest.advanceTimersByTime(STALLED_TURN_SILENCE_MS - 60_000);
    // Nine silent minutes into a twenty-minute window, the provider sends one token reading.
    send({ type: "context-usage", usedTokens: 15_853, windowTokens: 475_000 });
    expect(stalls(activities)).toEqual([]);
    // The model's own window still ends where the last work left it.
    jest.advanceTimersByTime(STALLED_TURN_MODEL_SILENCE_MS - (STALLED_TURN_SILENCE_MS - 60_000));
    // The busy heartbeat re-sends the same error Activity while the turn stays silent.
    expect(stalls(activities).length).toBeGreaterThan(0);
    expect(stalls(activities)).toContainEqual(
      expect.objectContaining({ detailKind: "runtime_stalled", level: "error" }),
    );
  } finally {
    jest.useRealTimers();
    await runtime.stop();
  }
});

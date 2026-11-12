import { afterAll, afterEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentRuntimeEvent, PROCESS_TREE_EXIT_GRACE_MS } from "@lrm/coforge-anvil";
import { CodexProvider } from "@lrm/coforge-anvil/codex";
import { codexRuntimeHost } from "#src/code-agent/codex/host";
import { DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS } from "#src/connection/shutdown-notice-timeout";
import { activityHarness } from "./fixtures/activity-runtime";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";

// A real Codex app-server running a command that outlives its window (task #41, s144
// 0.1.30-dev.3). The judgement has two ways to miss a running command, and only a real provider's
// frames can tell them apart:
//
//   A. The command's own `item/started` never reaches `stalled.observe()`, so the turn is judged on
//      the model window instead of the tool window — and a model window that a later frame keeps
//      moving never fills.
//   B. The frames Codex keeps sending while a command runs are counted as the turn's progress, so
//      the window's start is pushed further out with every frame.
//
// Both runs use the same shortened windows (a three-second tool window against a twenty-second
// model window, set through the launch's own environment) and a real fixture process, so a turn
// judged on the tool window shows the stall in seconds while a turn judged on the model window, or
// one whose start keeps moving, does not show it at all.

const TOOL_WINDOW_MS = 3_000;
const MODEL_WINDOW_MS = 20_000;
/** How long a test waits for the stall: past the tool window with slack, far short of the model's. */
const WAIT_MS = 10_000;

const tempRoot = realpathSync(tmpdir());
const workspaceRoot = join(tempRoot, `coforge-stalled-codex-fixture-${crypto.randomUUID()}`);
const connection = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
afterEach(() => {
  delete Bun.env.COFORGE_STALLED_TURN_SILENCE_MS;
  delete Bun.env.COFORGE_STALLED_TURN_MODEL_SILENCE_MS;
});

function waitForEvent(
  session: { subscribe(next: (event: AgentRuntimeEvent) => void): () => void },
  matches: (event: AgentRuntimeEvent) => boolean,
): { started: Promise<void>; stop: () => void } {
  let unsubscribe = () => {};
  const started = new Promise<void>((resolve) => {
    unsubscribe = session.subscribe((event) => {
      if (matches(event)) resolve();
    });
  });
  return { started, stop: () => unsubscribe() };
}

/** Boots a real Codex app-server fixture, ends its startup turn, and holds a command open. */
async function holdCommand(prompt: "hold-tool" | "hold-tool-traffic") {
  Bun.env.COFORGE_STALLED_TURN_SILENCE_MS = String(TOOL_WINDOW_MS);
  Bun.env.COFORGE_STALLED_TURN_MODEL_SILENCE_MS = String(MODEL_WINDOW_MS);
  const provider = new CodexProvider({
    host: codexRuntimeHost,
    command: [process.execPath, anvilRuntimeFixtures.codex],
  });
  const { runtime, session, activities } = await activityHarness(connection, provider);
  // The launch opens a startup turn; it ends through the fixture's own turn protocol.
  const startupEnded = waitForEvent(session, (event) => event.type === "completed");
  try {
    await session.notify!("finish-with-late-events");
    await startupEnded.started;
  } finally {
    startupEnded.stop();
  }
  activities.length = 0;
  const toolStarted = waitForEvent(
    session,
    (event) => event.type === "tool-start" && event.id === "current-command",
  );
  let startedAtMs: number;
  try {
    await session.notify!(prompt);
    await toolStarted.started;
    startedAtMs = Date.now();
  } finally {
    toolStarted.stop();
  }
  return { runtime, activities, startedAtMs };
}

/** Waits for the turn's stall notice, never longer than `WAIT_MS`. */
async function stalledSince(
  activities: readonly { detailKind: string; level: string }[],
  startedAtMs: number,
) {
  const deadline = startedAtMs + WAIT_MS;
  while (Date.now() < deadline) {
    const stall = activities.find((activity) => activity.detailKind === "runtime_stalled");
    if (stall) return { stall, elapsedMs: Date.now() - startedAtMs };
    await Bun.sleep(100);
  }
  return { stall: undefined, elapsedMs: Date.now() - startedAtMs };
}

test(
  "a real command's start reaches the tracker, so the turn is judged on the tool window",
  async () => {
    const { runtime, activities, startedAtMs } = await holdCommand("hold-tool");
    try {
      const { stall, elapsedMs } = await stalledSince(activities, startedAtMs);
      // Candidate A: the opened command is in the observation, so the ten-minute window (here
      // three seconds) judges the turn instead of the longer model window.
      expect(stall).toBeDefined();
      expect(elapsedMs).toBeLessThan(TOOL_WINDOW_MS * 2);
    } finally {
      await runtime.stop();
    }
  },
  5_000 + 2 * PROCESS_TREE_EXIT_GRACE_MS + DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS,
);

test(
  "the frames Codex sends during a command do not push the running window out",
  async () => {
    const { runtime, activities, startedAtMs } = await holdCommand("hold-tool-traffic");
    try {
      const { stall, elapsedMs } = await stalledSince(activities, startedAtMs);
      // Candidate B: thread status changes and token readings are not the command's progress, so
      // the window still ends where the command started rather than with the last frame.
      expect(stall).toBeDefined();
      expect(elapsedMs).toBeLessThan(TOOL_WINDOW_MS * 2);
    } finally {
      await runtime.stop();
    }
  },
  5_000 + 2 * PROCESS_TREE_EXIT_GRACE_MS + DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS,
);

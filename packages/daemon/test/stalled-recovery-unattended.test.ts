import { expect, setSystemTime, test } from "bun:test";
import type { AgentSession } from "@lrm/coforge-anvil";
import { AGENT_ACTIVITY_DETAIL_KIND } from "@lrm/coforge-sdk/internal";
import type { AgentRestartConfig } from "#src/agent-runtime/agent-process-manager";
import { activityDraft } from "#src/daemon-runtime/activity-draft";
import { AgentActivityPublisher } from "#src/daemon-runtime/agent-activity-publisher";
import {
  RuntimeRelease,
  type RuntimeReleasePorts,
  type WakeRestart,
} from "#src/daemon-runtime/runtime-release";
import { ProviderProgress, UNATTENDED_RECOVERY_LIMIT } from "#src/daemon-runtime/stalled-recovery";

// A busy turn that went silent is restarted even when no message waits for it (task #404): the
// relaunch resumes the session and tells the Agent where it stopped. Restarts with nothing
// waiting are capped per stuck spell; past the cap the owner is told and the Agent is left alone.

type Launch = { stopping: boolean; progress?: ProviderProgress };

function release() {
  const launch: Launch = { stopping: false, progress: new ProviderProgress() };
  const session = { hasLiveTurn: true } as unknown as AgentSession;
  const restart: AgentRestartConfig = {
    config: { provider: "pi", model: "m", modelProvider: "anthropic", reasoning: "balanced" },
    sessionId: "native-1",
  };
  const woken: WakeRestart[] = [];
  const published: Array<{ level: string; detailKind: string; text: string }> = [];
  const ports: RuntimeReleasePorts<Launch> = {
    launch: () => launch,
    runtime: () => ({ session }) as never,
    restartConfig: () => restart,
    lastBusy: () => ({
      launch,
      activity: {
        detailKind: "tool_start",
        level: "info",
        detail: "Running bash: npm test",
      } as never,
      at: Date.now(),
    }),
    queuedForMs: () => undefined,
    resumable: () => true,
    sessionId: () => "native-1",
    isStopping: () => false,
    daemonIdleFacts: () => ({}) as never,
    hasParkedWork: () => false,
    flushParked: () => {},
    wake: async (_agentId, next) => {
      woken.push(next);
    },
    publish: (_agentId, _launch, level, detailKind, text) => {
      published.push({ level, detailKind, text });
    },
    handBackMentions: async () => {},
    release: async () => {},
  };
  const stalled = { launch, session, restart, silentForMs: 16 * 60_000 };
  return { runtimeRelease: new RuntimeRelease(ports), stalled, launch, woken, published };
}

test("a stalled turn with no message waiting is resumed with where it stopped", async () => {
  const { runtimeRelease, stalled, woken, published } = release();
  await runtimeRelease.recoverStalled("agent-a", stalled, { unattended: true });

  expect(woken).toHaveLength(1);
  expect(woken[0]!.sessionId).toBe("native-1");
  expect(woken[0]!.resumePrompt).toContain("no output for 16 minutes");
  expect(woken[0]!.resumePrompt).toContain("Running bash: npm test");
  expect(woken[0]!.resumePrompt).toContain("No new message is waiting");
  expect(published[0]).toMatchObject({
    level: "info",
    detailKind: "stalled_recovery",
    text: "Restarting stalled Pi runtime; no message was waiting",
  });
});

test("a restart for a waiting message carries no resume prompt: the message is the prompt", async () => {
  const { runtimeRelease, stalled, woken, published } = release();
  await runtimeRelease.recoverStalled("agent-a", stalled);
  expect(woken[0]!.resumePrompt).toBeUndefined();
  expect(published[0]!.text).toBe("Restarting stalled Pi runtime for queued message");
});

test("restarts with nothing waiting stop at the limit, tell the owner once, and reset after a completed turn", async () => {
  const { runtimeRelease, stalled, launch, woken, published } = release();
  for (let n = 0; n < UNATTENDED_RECOVERY_LIMIT; n++)
    await runtimeRelease.recoverStalled("agent-a", stalled, { unattended: true });
  expect(woken).toHaveLength(UNATTENDED_RECOVERY_LIMIT);

  published.length = 0;
  await runtimeRelease.recoverStalled("agent-a", stalled, { unattended: true });
  await runtimeRelease.recoverStalled("agent-a", stalled, { unattended: true });
  expect(woken).toHaveLength(UNATTENDED_RECOVERY_LIMIT);
  expect(published).toEqual([
    expect.objectContaining({
      level: "error",
      // A stall, not a turn-ending kind: the hung turn must still read as stalled.
      detailKind: "runtime_stalled",
      text: expect.stringContaining(`after ${UNATTENDED_RECOVERY_LIMIT} automatic restarts`),
    }),
  ]);

  // A turn that completes ends the stuck spell: the next stall may be restarted again.
  await Bun.sleep(2);
  launch.progress!.observe({ type: "completed" });
  await runtimeRelease.recoverStalled("agent-a", stalled, { unattended: true });
  expect(woken).toHaveLength(UNATTENDED_RECOVERY_LIMIT + 1);
});

test("a turn waiting on a background task is not restarted when nothing is queued", async () => {
  const { runtimeRelease, stalled, launch, woken } = release();
  (launch as { backgroundTasks?: { count: number } }).backgroundTasks = { count: 1 };
  await runtimeRelease.recoverStalled("agent-a", stalled, { unattended: true });
  expect(woken).toEqual([]);
});

test("past the limit, a different launch (a message or a person restarted it) starts a new run", async () => {
  const { runtimeRelease, stalled, woken } = release();
  for (let n = 0; n <= UNATTENDED_RECOVERY_LIMIT; n++)
    await runtimeRelease.recoverStalled("agent-a", stalled, { unattended: true });
  expect(woken).toHaveLength(UNATTENDED_RECOVERY_LIMIT);
  const relaunched = { ...stalled, launch: { stopping: false, progress: new ProviderProgress() } };
  await runtimeRelease.recoverStalled("agent-a", relaunched, { unattended: true });
  expect(woken).toHaveLength(UNATTENDED_RECOVERY_LIMIT + 1);
});

test("with the real publisher, the limit notice leaves the hung turn judged stalled", async () => {
  const launch = {
    launchId: "launch-1",
    clientSeq: 0,
    stopping: false,
    progress: new ProviderProgress(),
  };
  const publisher = new AgentActivityPublisher<typeof launch>({
    currentLaunch: () => launch,
    transport: { sendAgentActivity() {} },
    recordClientSeq() {},
    reconcileIdleTurn: () => false,
  });
  publisher.enable();
  const draft = (detailKind: string, level: "info" | "error", detail: string) =>
    activityDraft("workspace-a", "agent-a", detailKind, level, detail);
  publisher.publish(
    "agent-a",
    launch,
    draft(AGENT_ACTIVITY_DETAIL_KIND.THINKING_STARTED, "info", "Thinking"),
  );
  const session = { hasLiveTurn: true } as unknown as AgentSession;
  const restart: AgentRestartConfig = {
    config: { provider: "pi", model: "m", modelProvider: "anthropic", reasoning: "balanced" },
    sessionId: "native-1",
  };
  const runtimeRelease = new RuntimeRelease<typeof launch>({
    launch: () => launch,
    runtime: () => ({ session }) as never,
    restartConfig: () => restart,
    lastBusy: (agentId) => publisher.lastBusy(agentId),
    queuedForMs: () => undefined,
    resumable: () => true,
    sessionId: () => "native-1",
    isStopping: () => false,
    daemonIdleFacts: () => ({}) as never,
    hasParkedWork: () => false,
    flushParked: () => {},
    // The stalled launch stays current: no relaunch replaces it in this test.
    wake: async () => {},
    publish: (agentId, current, level, detailKind, text) =>
      publisher.publish(agentId, current, draft(detailKind, level, text)),
    handBackMentions: async () => {},
    release: async () => {},
  });
  try {
    launch.progress = new ProviderProgress();
    setSystemTime(new Date(Date.now() + 16 * 60_000));
    const stalled = runtimeRelease.stalled("agent-a")!;
    expect(stalled).toBeDefined();
    for (let n = 0; n <= UNATTENDED_RECOVERY_LIMIT; n++) {
      launch.stopping = false;
      await runtimeRelease.recoverStalled("agent-a", stalled, { unattended: true });
    }
    launch.stopping = false;
    // A message arriving now still finds a stalled turn to restart.
    expect(runtimeRelease.stalled("agent-a")).toBeDefined();
  } finally {
    setSystemTime();
    publisher.forgetBusy("agent-a");
  }
});

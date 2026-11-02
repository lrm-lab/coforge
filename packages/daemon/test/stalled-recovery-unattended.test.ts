import { expect, test } from "bun:test";
import type { AgentSession } from "@lrm/coforge-anvil";
import type { AgentRestartConfig } from "#src/agent-runtime/agent-process-manager";
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
      detailKind: "runtime_error",
      text: expect.stringContaining(`after ${UNATTENDED_RECOVERY_LIMIT} automatic restarts`),
    }),
  ]);

  // A turn that completes ends the stuck spell: the next stall may be restarted again.
  await Bun.sleep(2);
  launch.progress!.observe({ type: "completed" });
  await runtimeRelease.recoverStalled("agent-a", stalled, { unattended: true });
  expect(woken).toHaveLength(UNATTENDED_RECOVERY_LIMIT + 1);
});

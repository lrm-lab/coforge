import { expect, test } from "bun:test";
import type { AgentSession } from "@lrm/coforge-anvil";
import type { AgentRestartConfig } from "#src/agent-runtime/agent-process-manager";
import { countLiveProcessDescendants } from "#src/agent-runtime/process-descendants";
import { ToolCallLedger } from "#src/agent-runtime/tool-call-ledger";
import { ColdIdleSweep } from "#src/daemon-runtime/cold-idle-sweep";
import { assembleRuntimeRelease } from "#src/daemon-runtime/runtime-release-assembly";
import {
  MentionDeliveryTracker,
  type TrackedMentionDelivery,
} from "#src/daemon-runtime/mention-delivery-tracker";

const AGENT = "agent-a";
const restart: AgentRestartConfig = {
  config: { provider: "pi", model: "m", modelProvider: "anthropic", reasoning: "balanced" },
  sessionId: "native-1",
};
const mention = {
  agentId: AGENT,
  deliveryId: "delivery-1",
  messageId: "message-1",
  conversationId: "conversation-1",
  mentionDelivery: {
    messageId: "message-1",
    launchId: "l1",
    sessionId: "s1",
    computerId: "computer-1",
  },
} as unknown as TrackedMentionDelivery;

/** A live, otherwise idle Agent whose tracker is asked about by the cold idle sweep. */
function fixture(background?: {
  processId: number;
  toolCalls: ToolCallLedger;
  countLiveDescendants: typeof countLiveProcessDescendants;
}) {
  let busy = false;
  let stops = 0;
  const config = background
    ? {
        ...restart.config,
        provider: "antigravity" as const,
        envVars: {
          COFORGE_WAKE_RECYCLE: "1",
          COFORGE_WAKE_RECYCLE_WARM_MIN_CONTEXT_TOKENS: "250000",
          COFORGE_WAKE_RECYCLE_WARM_QUIET_MS: "120000",
        },
      }
    : restart.config;
  const session = { hasLiveTurn: false, processId: background?.processId } as AgentSession;
  const tracker = new MentionDeliveryTracker("computer-1", {
    transition: async () => {},
    terminalError: async () => {},
    acknowledge: async () => {},
    running: () => ({ launchId: "l1", sessionId: "s1" }),
    consumed: () => false,
    told: () => false,
    announce: async () => "told",
    announceBatch: async () => "told",
    busy: () => busy,
    blocked: () => undefined,
    remembered: () => ({ launchId: "l1", sessionId: "s1" }),
  });
  const launch = {
    stopping: false,
    progress: { lastEventAtMs: 1 },
    toolCalls: background?.toolCalls ?? { hasOpenToolCall: false },
    backgroundTasks: { count: 0 },
    lastContextTokens: 300_000,
  };
  const release = assembleRuntimeRelease({
    launches: () => new Map([[AGENT, launch]]) as never,
    processManager: () =>
      ({
        runtime: () => ({
          session,
          config,
        }),
        restartConfig: () => ({ ...restart, config }),
        release: async () => void (stops += 1),
        isStopping: () => false,
      }) as never,
    activityPublisher: () => ({ lastBusy: () => undefined, publish: () => {} }),
    activity: () => ({}) as never,
    inputDrain: () => ({ get: () => undefined }),
    working: () => false,
    deliveryGate: () => ({
      queuedForMs: () => undefined,
      explicitHold: () => undefined,
      credentialHeld: () => false,
      hasQueued: () => false,
      hasHeldAppItems: () => false,
      discardPending: () => [],
    }),
    agentLaunches: () => new Map(),
    stopState: () => ({
      sessionId: () => "native-1",
      stopping: () => false,
      isStopping: () => false,
    }),
    runnerHold: () => undefined,
    countLiveDescendants: background?.countLiveDescendants,
    migrations: () => undefined,
    runningMentionIdentity: () => ({ launchId: "l1", sessionId: "s1" }),
    noticeActionClocks: () => ({
      noticeAcceptedAt: () => undefined,
      noticeAcceptedForMs: () => undefined,
      lastAgentActionForMs: () => undefined,
    }),
    releaseSurvivingHolds: () => {},
    wakeAgent: async () => {},
    mentionDeliveries: () => tracker,
  });
  return {
    tracker,
    release,
    getStops: () => stops,
    setBusy: (value: boolean) => void (busy = value),
  };
}

// The reference Computer's idle check refuses to reclaim an Agent while any tracked mention of it
// is open (received, told in a turn that has not ended, or kept for the next launch).

test("an Agent with no open mention is idle for the cold idle sweep", () => {
  expect(fixture().release.coldIdleAgent(AGENT)?.busyReason).toBeUndefined();
});

test("a mention kept for the next launch keeps the Agent from being reclaimed until it is settled", () => {
  const { tracker, release } = fixture();
  tracker.carry.hold(mention);
  expect(release.coldIdleAgent(AGENT)?.busyReason).toBe("tracked_mention");

  tracker.carry.refuseCarried(AGENT, "DELIVERY_REJECTED");
  expect(release.coldIdleAgent(AGENT)?.busyReason).toBeUndefined();
});

test("a mention told in a turn keeps the Agent from being reclaimed until that turn ends", async () => {
  const { tracker, release, setBusy } = fixture();
  setBusy(true);
  await tracker.deliver(mention);
  expect(release.coldIdleAgent(AGENT)?.busyReason).toBe("tracked_mention");

  setBusy(false);
  tracker.settleTurnEnd(AGENT);
  expect(release.coldIdleAgent(AGENT)?.busyReason).toBeUndefined();
});

test("cold idle does not release an Antigravity session while its unfinished command is still running", async () => {
  const calls = new ToolCallLedger(undefined, undefined, undefined, {
    trackUnfinishedCommands: true,
  });
  calls.observe({ type: "tool-start", id: "command-1", name: "run_command" });
  const owner = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const child = Bun.spawn([process.execPath, "-e", "await Bun.stdin.text()"], {
          stdin: "pipe", stdout: "ignore", stderr: "ignore",
        });
        console.log("ready");
        for await (const line of console) {
          if (line !== "finish") continue;
          child.stdin.end();
          await child.exited;
          console.log("done");
        }
        child.stdin.end();
        await child.exited;`,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
  );
  const stdout = owner.stdout.getReader();
  let commandRunning = true;
  const countLiveDescendants: typeof countLiveProcessDescendants =
    process.platform === "win32"
      ? async () => (commandRunning ? 1 : 0)
      : countLiveProcessDescendants;
  try {
    const ready = await stdout.read();
    expect(new TextDecoder().decode(ready.value).trim()).toBe("ready");
    expect(await countLiveDescendants(owner.pid)).toBe(1);
    calls.observe({ type: "completed", status: "completed" });
    const { release, getStops } = fixture({
      processId: owner.pid,
      toolCalls: calls,
      countLiveDescendants,
    });
    const sweep = new ColdIdleSweep({
      agentIds: () => [AGENT],
      agent: (agentId) => release.coldIdleAgent(agentId),
      provider: () => {
        throw new Error("summary-backed Antigravity provider");
      },
      providerCapabilities: () => ({
        supportsSessionSummaryRecycle: true,
        hasNativeSessionResumeFacts: false,
      }),
      readSummaryFacts: () => ({ lastActivityAtMs: 1, lastContextTokens: 300_000 }),
      now: () => 120_027,
      stop: (stop) => release.stopColdIdle(stop),
    });

    await sweep.sweep();
    expect(getStops()).toBe(0);

    owner.stdin.write("finish\n");
    owner.stdin.flush();
    const done = await stdout.read();
    expect(new TextDecoder().decode(done.value).trim()).toBe("done");
    commandRunning = false;
    expect(await countLiveDescendants(owner.pid)).toBe(0);
    await sweep.sweep();
    expect(getStops()).toBe(1);
  } finally {
    stdout.releaseLock();
    owner.stdin.end();
    await owner.exited;
  }
});

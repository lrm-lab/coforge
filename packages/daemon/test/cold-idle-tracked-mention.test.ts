import { expect, test } from "bun:test";
import type { AgentSession } from "@lrm/coforge-anvil";
import type { AgentRestartConfig } from "#src/agent-runtime/agent-process-manager";
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
function fixture() {
  let busy = false;
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
    toolCalls: { hasOpenToolCall: false },
    backgroundTasks: { count: 0 },
  };
  const release = assembleRuntimeRelease({
    launches: () => new Map([[AGENT, launch]]) as never,
    processManager: () =>
      ({
        runtime: () => ({
          session: { hasLiveTurn: false } as AgentSession,
          config: restart.config,
        }),
        restartConfig: () => restart,
        release: async () => {},
        isStopping: () => false,
      }) as never,
    activityPublisher: () => ({ lastBusy: () => undefined, publish: () => {} }),
    activity: () => ({}) as never,
    inputDrain: () => ({ get: () => undefined }),
    working: () => false,
    deliveryGate: () => ({
      queuedForMs: () => undefined,
      explicitHold: () => undefined,
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
    migrations: () => undefined,
    runningMentionIdentity: () => ({ launchId: "l1", sessionId: "s1" }),
    noticeActionClocks: () => ({
      noticeAcceptedAt: () => undefined,
      lastAgentActionAt: () => undefined,
    }),
    releaseSurvivingHolds: () => {},
    wakeAgent: async () => {},
    mentionDeliveries: () => tracker,
  });
  return { tracker, release, setBusy: (value: boolean) => void (busy = value) };
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

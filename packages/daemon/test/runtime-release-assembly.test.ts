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

/** A cold idle stop of an Agent whose only waiting work is a tracked mention carried to its next
 * launch: nothing queued in the delivery gate, no App Inbox item. */
async function stopWithCarriedMention(carried: boolean) {
  const tracker = new MentionDeliveryTracker("computer-1", {
    transition: async () => {},
    terminalError: async () => {},
    acknowledge: async () => {},
    running: () => undefined,
    consumed: () => false,
    told: () => false,
    announce: async () => "told",
    busy: () => false,
    blocked: () => undefined,
    remembered: () => ({ launchId: "l1", sessionId: "s1" }),
  });
  if (carried)
    tracker.carry.hold({
      agentId: AGENT,
      deliveryId: "delivery-1",
      messageId: "message-1",
      mentionDelivery: {
        messageId: "message-1",
        launchId: "l1",
        sessionId: "s1",
        computerId: "computer-1",
      },
    } as unknown as TrackedMentionDelivery);
  const woken: string[] = [];
  const launch = { stopping: false };
  const release = assembleRuntimeRelease({
    launches: () => new Map([[AGENT, launch]]),
    processManager: () =>
      ({
        runtime: () => ({ session: {} as AgentSession, config: restart.config }),
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
    wakeAgent: async (agentId) => void woken.push(agentId),
    mentionDeliveries: () => tracker,
  });
  await release.stopColdIdle({
    agentId: AGENT,
    sessionId: "native-1",
    idleMs: 1,
    priorContextTokens: 1,
  });
  return woken;
}

test("a cold idle stop wakes the Agent for a mention carried to its next launch", async () => {
  expect(await stopWithCarriedMention(true)).toEqual([AGENT]);
});

test("a cold idle stop with nothing waiting leaves the Agent stopped", async () => {
  expect(await stopWithCarriedMention(false)).toEqual([]);
});

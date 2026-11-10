import { expect, test } from "bun:test";
import type { AgentRestartConfig } from "#src/agent-runtime/agent-process-manager";
import {
  AgentExitedDelivery,
  type AgentExitedDeliveryPorts,
} from "#src/daemon-runtime/agent-exited-delivery";
import type { TrackedMentionDelivery } from "#src/daemon-runtime/mention-delivery-tracker";

const AGENT = "agent-a";
const restart = { config: { provider: "pi" } } as unknown as AgentRestartConfig;
const mention = { agentId: AGENT, deliveryId: "delivery-1" } as TrackedMentionDelivery;

/** An Agent whose wake launch failed, with a tracked mention its input queue had taken. */
function subject(state: { restart?: AgentRestartConfig } = { restart }) {
  const calls = { held: [] as string[], refused: [] as string[], refusedKept: [] as string[] };
  const exited = new AgentExitedDelivery({
    restartConfig: () => state.restart,
    drainInputDeliveries: () => [mention],
    holdMention: (message: TrackedMentionDelivery) => (calls.held.push(message.deliveryId), true),
    refuseKeptMentions: (_agentId: string, code: string) => void calls.refused.push(code),
    refuseKeptMention: (message: TrackedMentionDelivery, code: string) =>
      void calls.refusedKept.push(`${message.deliveryId}:${code}`),
    hasKeptMentions: () => true,
    wakeBlockedUntil: () => undefined,
    whenCancelled: () => {},
  } as unknown as AgentExitedDeliveryPorts);
  return { exited, calls };
}

test("a failed wake keeps the mentions its input had taken, and refuses none", () => {
  const { exited, calls } = subject();
  exited.keepAfterFailedLaunch(AGENT, new Error("the provider would not start"));
  expect(calls).toEqual({ held: ["delivery-1"], refused: [], refusedKept: [] });
});

test("a failed wake with nothing left to relaunch from refuses what is kept as unknown", () => {
  const { exited, calls } = subject({ restart: undefined });
  exited.keepAfterFailedLaunch(AGENT, new Error("the provider would not start"));
  expect(calls.refused).toEqual(["IDENTITY_UNKNOWN"]);
});

test("the wake armed for the end of a cooldown waits for a runtime-error backoff to end", async () => {
  const state = { until: Date.now() + 30, woken: 0 };
  const exited = new AgentExitedDelivery({
    restartConfig: () => restart,
    hasRuntimeErrorHold: () => true,
    hasKeptMentions: () => true,
    hasQueued: () => false,
    launchComing: () => false,
    wakeBlockedUntil: () => (state.until > Date.now() ? state.until : undefined),
    wakeAgent: async () => void state.woken++,
    whenCancelled: () => {},
  } as unknown as AgentExitedDeliveryPorts);

  exited.wakeFailed(AGENT);
  await new Promise((resolve) => setTimeout(resolve, 120));

  expect(state.woken).toBe(0);
});

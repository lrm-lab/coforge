import { expect, test } from "bun:test";
import type { AgentRestartConfig } from "#src/agent-runtime/agent-process-manager";
import {
  AgentExitedDelivery,
  type AgentExitedDeliveryPorts,
} from "#src/daemon-runtime/agent-exited-delivery";
import type { TrackedMentionDelivery } from "#src/daemon-runtime/mention-delivery-tracker";

const AGENT = "agent-a";
const restart = { config: { provider: "pi" } } as unknown as AgentRestartConfig;

/** An exited Agent that has a mention kept for it while its wake launches wait out a cooldown. */
function subject(cooldownMs: number) {
  const state = {
    blockedUntil: Date.now() + cooldownMs,
    wokenAt: [] as number[],
    cancel: undefined as (() => void) | undefined,
  };
  const exited = new AgentExitedDelivery({
    restartConfig: () => restart,
    offline: { has: () => false, restate: () => {} },
    hasRuntimeErrorHold: () => false,
    keepMention: () => true,
    hasKeptMentions: () => true,
    hasQueued: () => false,
    hasSession: () => false,
    wakeBlockedUntil: () => (state.blockedUntil! > Date.now() ? state.blockedUntil : undefined),
    wakeAgent: async () => void state.wokenAt.push(Date.now()),
    whenCancelled: (_agentId: string, hook: () => void) => {
      state.cancel = hook;
    },
  } as unknown as AgentExitedDeliveryPorts);
  exited.deliverMention({ agentId: AGENT, deliveryId: "delivery-1" } as TrackedMentionDelivery);
  return { state };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a cooldown that was extended meanwhile is waited out before the wake", async () => {
  const { state } = subject(30);
  const extended = Date.now() + 120;
  state.blockedUntil = extended;

  await sleep(200);

  expect(state.wokenAt).toHaveLength(1);
  expect(state.wokenAt[0]!).toBeGreaterThanOrEqual(extended - 5);
});

test("a cancelled Agent is not woken when its cooldown ends", async () => {
  const { state } = subject(30);
  state.cancel!();

  await sleep(100);

  expect(state.wokenAt).toEqual([]);
});

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

/** An Agent with no process whose tracked mentions the settlement is asked about. */
function subject(
  state: {
    hold?: "backoff" | "fence";
    offline?: boolean;
    restart?: AgentRestartConfig;
    session?: boolean;
    kept?: boolean;
  } = {},
) {
  const calls = { kept: 0, dropped: 0, woken: 0, refused: 0 };
  const exited = new AgentExitedDelivery({
    restartConfig: () => ("restart" in state ? state.restart : restart),
    offline: { has: () => state.offline === true, restate: () => {} },
    hasRuntimeErrorHold: () => state.hold !== undefined,
    backoffHeld: () => state.hold === "backoff",
    keepMention: () => (calls.kept++, true),
    dropMentionAsUnknown: () => (calls.dropped++, true),
    hasKeptMentions: () => state.kept ?? calls.kept > 0,
    refuseKeptMentions: () => void calls.refused++,
    hasQueued: () => false,
    hasSession: () => state.session === true,
    wakeBlockedUntil: () => undefined,
    wakeAgent: async () => void calls.woken++,
    whenCancelled: () => {},
  } as unknown as AgentExitedDeliveryPorts);
  return { exited, calls };
}

test("a mention for an Agent held by a retryable-error backoff is kept and wakes nobody", () => {
  const { exited, calls } = subject({ hold: "backoff" });
  exited.deliverMention(mention);
  expect(calls).toEqual({ kept: 1, dropped: 0, woken: 0, refused: 0 });
});

test("a mention for an Agent a tripped fence holds is refused as unknown", () => {
  const { exited, calls } = subject({ hold: "fence" });
  exited.deliverMention(mention);
  expect(calls).toEqual({ kept: 0, dropped: 1, woken: 0, refused: 0 });
});

test("a mention for an Agent a runtime error took offline is refused as unknown, backoff or not", () => {
  const { exited, calls } = subject({ hold: "backoff", offline: true });
  exited.deliverMention(mention);
  expect(calls).toEqual({ kept: 0, dropped: 1, woken: 0, refused: 0 });
});

test("a mention with nothing to relaunch from is refused as unknown under a backoff", () => {
  const { exited, calls } = subject({ hold: "backoff", restart: undefined });
  exited.deliverMention(mention);
  expect(calls).toEqual({ kept: 0, dropped: 1, woken: 0, refused: 0 });
});

test("the end of the backoff wakes the Agent once for the mentions it kept", async () => {
  const { exited, calls } = subject({ hold: "backoff" });
  exited.deliverMention(mention);
  exited.backoffEnded(AGENT);
  await Promise.resolve();
  expect(calls.woken).toBe(1);
});

test("the end of a backoff wakes nobody when no mention is kept or a process runs", () => {
  for (const state of [{ kept: false }, { kept: true, session: true }]) {
    const { exited, calls } = subject(state);
    exited.backoffEnded(AGENT);
    expect(calls).toEqual({ kept: 0, dropped: 0, woken: 0, refused: 0 });
  }
});

test("the end of a backoff refuses the kept mentions when nothing is left to relaunch from", () => {
  const { exited, calls } = subject({ kept: true, restart: undefined });
  exited.backoffEnded(AGENT);
  expect(calls).toEqual({ kept: 0, dropped: 0, woken: 0, refused: 1 });
});

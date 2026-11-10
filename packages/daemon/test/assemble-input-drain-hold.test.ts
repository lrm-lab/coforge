import { expect, test } from "bun:test";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { assembleInputDrain } from "#src/daemon-runtime/assemble-input-drain";

/** An input drain whose Agent has a mention kept for its launch. */
function drain(runnerHeld: boolean) {
  const calls = { taken: 0, told: 0, flushed: [] as string[][] };
  const input = assembleInputDrain({
    runnerHeld: () => runnerHeld,
    mentionDeliveries: () => ({
      carry: {
        hasCarried: () => true,
        takeCarried: () => (calls.taken++, [{ deliveryId: "delivery-1" }]),
        tell: async () => void calls.told++,
      },
    }),
    messageAttention: () => ({
      flush: async (_: string, held: AgentMessageDelivery[]) =>
        void calls.flushed.push(held.map(({ deliveryId }) => deliveryId)),
    }),
    deliveryGate: () => ({ inboxes: undefined }),
  } as never);
  return { input, calls };
}

const held = [{ deliveryId: "delivery-2" }] as AgentMessageDelivery[];

test("the mentions kept for a launch are told with the deliveries held for it", async () => {
  const { input, calls } = drain(false);
  await input.tellCarried("agent-a", held);
  expect(calls).toEqual({ taken: 1, told: 1, flushed: [] });
});

test("under a runner hold the kept mentions stay kept and only the held deliveries are presented", async () => {
  const { input, calls } = drain(true);
  await input.tellCarried("agent-a", held);
  expect(calls).toEqual({ taken: 0, told: 0, flushed: [["delivery-2"]] });
});

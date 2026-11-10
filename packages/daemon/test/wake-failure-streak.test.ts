import { expect, test } from "bun:test";
import { LaunchFailureBackoff } from "#src/agent-runtime/launch-failure-backoff";
import { assembleExitedDelivery } from "#src/daemon-runtime/assemble-exited-delivery";
import type { TrackedMentionDelivery } from "#src/daemon-runtime/mention-delivery-tracker";
import { beginWakeLaunch, WAKE_FAILURE_STREAK_CAP } from "#src/daemon-runtime/wake-launch";

const AGENT = "agent-a";
const restart = { config: { provider: "pi" } };
const mention = (id: number) =>
  ({ agentId: AGENT, deliveryId: `delivery-${id}`, mentionDelivery: {} }) as TrackedMentionDelivery;
const notInstalled = Object.assign(new Error("the runtime is missing"), {
  upstreamCode: "RUNTIME_NOT_INSTALLED",
});

/** The exited-delivery settlement of an Agent whose every wake launch fails with `error`, over a
 * tens-of-milliseconds wake cooldown. The carry keeps the mentions it is handed until one is refused. */
function subject(error: Error) {
  const state = { wakes: 0, restart: restart as typeof restart | undefined, forgotten: 0 };
  const kept = new Set<string>();
  const refused: string[] = [];
  const failures = new LaunchFailureBackoff(20, 40);
  const refuse = (id: string, code: string) => {
    if (kept.delete(id)) refused.push(`${id}:${code}`);
  };
  const exited = assembleExitedDelivery({
    deliveryGate: { explicitHold: () => undefined, hasQueued: () => false },
    wakeLaunchFailures: failures,
    wakeAgent: (agentId: string) => {
      state.wakes++;
      return beginWakeLaunch(agentId, Promise.reject(error), new Set(), failures);
    },
    agentProcessManager: () => ({
      restartConfig: () => state.restart,
      session: () => undefined,
      forgetRestart: () => {
        state.restart = undefined;
        state.forgotten++;
      },
    }),
    agentControl: () => ({ startPending: () => false }),
    inputDrain: () => ({ isLaunching: () => false }),
    offlineResidency: () => ({ has: () => false }),
    mentionDeliveries: () => ({
      whenCancelled: () => {},
      carry: {
        hold: (message: TrackedMentionDelivery) => (kept.add(message.deliveryId), true),
        hasCarried: () => kept.size > 0,
        refuseKeptOne: (message: TrackedMentionDelivery, code: string) =>
          refuse(message.deliveryId, code),
        refuseCarried: (_: string, code: string) => {
          for (const id of kept) refuse(id, code);
        },
      },
    }),
  } as never);
  /** Resolves once every kept mention has an outcome. */
  const settled = async () => {
    while (kept.size) await new Promise((resolve) => setTimeout(resolve, 2));
  };
  return { exited, state, failures, refused, settled, kept };
}

test("a wake that keeps failing gives up after the streak cap and refuses what is kept", async () => {
  const { exited, state, failures, refused, settled, kept } = subject(new Error("spawn blew up"));

  // Arrived while the first wake was starting: kept for the launch that was coming.
  kept.add("delivery-2");
  exited.deliverMention(mention(1));
  await settled();

  expect(state.wakes).toBe(WAKE_FAILURE_STREAK_CAP);
  // The mention whose arrival started the wake is rejected once; the other has no launch left.
  expect(refused).toEqual(["delivery-1:DELIVERY_REJECTED", "delivery-2:IDENTITY_UNKNOWN"]);
  // Nothing relaunches the Agent on its own any more: its wake config and cooldown are gone.
  expect(state.forgotten).toBe(1);
  expect(failures.isBlocked(AGENT)).toBe(false);
  const wakes = state.wakes;
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(state.wakes).toBe(wakes);
});

test("a wake that no retry can fix gives up at its first failure", async () => {
  const { exited, state, refused, settled, kept } = subject(notInstalled);

  kept.add("delivery-2");
  exited.deliverMention(mention(1));
  await settled();

  expect(state.wakes).toBe(1);
  expect(refused).toEqual(["delivery-1:DELIVERY_REJECTED", "delivery-2:IDENTITY_UNKNOWN"]);
  expect(state.forgotten).toBe(1);
});

test("failures that wait on a named quota reset do not count toward the cap", async () => {
  const failures = new LaunchFailureBackoff();
  const quota = new Error("You've reached your weekly usage limit. Resets in 3h (3:45pm).");
  for (let attempt = 0; attempt < WAKE_FAILURE_STREAK_CAP + 1; attempt++)
    await expect(
      beginWakeLaunch(AGENT, Promise.reject(quota), new Set(), failures),
    ).rejects.toThrow("usage limit");

  expect(failures.exhausted(AGENT, WAKE_FAILURE_STREAK_CAP)).toBe(false);
  await expect(
    beginWakeLaunch(AGENT, Promise.reject(new Error("spawn blew up")), new Set(), failures),
  ).rejects.toThrow("spawn blew up");
  expect(failures.exhausted(AGENT, WAKE_FAILURE_STREAK_CAP)).toBe(false);
});

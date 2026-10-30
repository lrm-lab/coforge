import { expect, test } from "bun:test";
import {
  StalledRecoverySweep,
  type StalledRecoverySweepPorts,
} from "#src/daemon-runtime/stalled-recovery-sweep";
import type { ReleasableLaunch, StalledRuntime } from "#src/daemon-runtime/runtime-release";

type Launch = ReleasableLaunch & { id: string };

function ports(overrides: Partial<StalledRecoverySweepPorts<Launch>> = {}) {
  const recovered: string[] = [];
  const p: StalledRecoverySweepPorts<Launch> = {
    agentIds: () => [],
    hasQueuedDeliveries: () => true,
    runnerHold: () => false,
    isStopping: () => false,
    isRecovering: () => false,
    stalled: () => undefined,
    recover: async (agentId) => {
      recovered.push(agentId);
    },
    ...overrides,
  };
  return { p, recovered };
}

const stalledRuntime = (agentId: string): StalledRuntime<Launch> => ({
  launch: { id: agentId, stopping: false },
  session: {} as StalledRuntime<Launch>["session"],
  restart: {} as StalledRuntime<Launch>["restart"],
  silentForMs: 16 * 60_000,
});

test("the sweep restarts a stalled Agent that has deliveries waiting", async () => {
  const stalled = stalledRuntime("agent-a");
  const { p, recovered } = ports({
    agentIds: () => ["agent-a", "agent-b"],
    stalled: (id) => (id === "agent-a" ? stalled : undefined),
  });
  await new StalledRecoverySweep(p).sweep();
  expect(recovered).toEqual(["agent-a"]);
});

test("a stalled Agent with nothing queued is left alone", async () => {
  const stalled = stalledRuntime("agent-a");
  const { p, recovered } = ports({
    agentIds: () => ["agent-a"],
    hasQueuedDeliveries: () => false,
    stalled: () => stalled,
  });
  await new StalledRecoverySweep(p).sweep();
  expect(recovered).toEqual([]);
});

test("a runner hold or a recovery in flight suppresses the judgment", async () => {
  const stalled = stalledRuntime("agent-a");
  const held = ports({
    agentIds: () => ["agent-a"],
    runnerHold: () => true,
    stalled: () => stalled,
  });
  await new StalledRecoverySweep(held.p).sweep();
  expect(held.recovered).toEqual([]);

  const busy = ports({
    agentIds: () => ["agent-a"],
    isRecovering: () => true,
    stalled: () => stalled,
  });
  await new StalledRecoverySweep(busy.p).sweep();
  expect(busy.recovered).toEqual([]);

  const stopping = ports({
    agentIds: () => ["agent-a"],
    isStopping: () => true,
    stalled: () => stalled,
  });
  await new StalledRecoverySweep(stopping.p).sweep();
  expect(stopping.recovered).toEqual([]);
});

test("one Agent's failed recovery does not stop the sweep or reject it", async () => {
  const stalled = stalledRuntime("agent-a");
  const { p, recovered } = ports({
    agentIds: () => ["agent-a", "agent-b"],
    stalled: () => stalled,
    recover: async (agentId) => {
      if (agentId === "agent-a") throw new Error("relaunch refused");
      recovered.push(agentId);
    },
  });
  await new StalledRecoverySweep(p).sweep();
  expect(recovered).toEqual(["agent-b"]);
});

test("concurrent sweeps join rather than repeat", async () => {
  const stalled = stalledRuntime("agent-a");
  let calls = 0;
  const { p, recovered } = ports({
    agentIds: () => ["agent-a"],
    stalled: () => {
      calls++;
      return stalled;
    },
    recover: async (agentId) => {
      await Bun.sleep(20);
      recovered.push(agentId);
    },
  });
  const sweep = new StalledRecoverySweep(p);
  await Promise.all([sweep.sweep(), sweep.sweep(), sweep.sweep()]);
  expect(calls).toBe(1);
  expect(recovered).toEqual(["agent-a"]);
});

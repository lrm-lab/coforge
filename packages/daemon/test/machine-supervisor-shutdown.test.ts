import { expect, test } from "bun:test";
import { MachineSupervisor, type ManagedBinding } from "#src/supervisor/machine-supervisor";

/**
 * What a Coordinator's shutdown costs (task #726). One Workspace's stop may spend the whole
 * process-tree ladder (30 s), so a shutdown that stops them one after another can outlast
 * launchd's ExitTimeOut and be killed mid-teardown. These are in their own file because the
 * supervisor's suite is already at the size limit.
 */
const saved: ManagedBinding[] = [
  { workspaceId: "a", computerId: "c", workspaceRoot: "/a", enabled: true },
  { workspaceId: "b", computerId: "c", workspaceRoot: "/b", enabled: true },
];

test("shutdown stops every Workspace at once, not one after another", async () => {
  // Each stop stays pending until the test releases it, which only completes if both began
  // before either finished.
  const pending = new Map<string, () => void>();
  const started: string[] = [];
  const supervisor = new MachineSupervisor(
    { load: async () => saved, save: async () => {} },
    {
      start: async (binding) => `instance-${binding.workspaceId}`,
      stop: (binding) =>
        new Promise<void>((resolve) => {
          started.push(binding.workspaceId);
          pending.set(binding.workspaceId, resolve);
        }),
      instance: async (binding) => `instance-${binding.workspaceId}`,
    },
  );
  await supervisor.recover();

  const shutdown = supervisor.shutdown();
  const deadline = Date.now() + 1_000;
  while (started.length < 2 && Date.now() < deadline) await Bun.sleep(1);
  expect(started.sort()).toEqual(["a", "b"]);
  for (const release of pending.values()) release();
  await shutdown;
});

test("shutdown stops every Workspace even when one of them fails to stop", async () => {
  // The stop that fails is a report, not a reason to leave the others up.
  const stopped: string[] = [];
  const supervisor = new MachineSupervisor(
    { load: async () => saved, save: async () => {} },
    {
      start: async (binding) => `instance-${binding.workspaceId}`,
      stop: async (binding) => {
        stopped.push(binding.workspaceId);
        if (binding.workspaceId === "a") throw new Error("unit would not stop");
      },
      instance: async (binding) => `instance-${binding.workspaceId}`,
    },
  );
  await supervisor.recover();

  await expect(supervisor.shutdown()).rejects.toThrow("unit would not stop");
  expect(stopped.sort()).toEqual(["a", "b"]);
});

test("shutdown reports a failure only after the slowest stop has finished", async () => {
  // A rejection must not end the shutdown while another Workspace is still tearing down: the
  // process would exit underneath it, which is exactly what stopping in parallel avoids.
  const slowStopMs = 50;
  let slowStopFinished = false;
  const supervisor = new MachineSupervisor(
    { load: async () => saved, save: async () => {} },
    {
      start: async (binding) => `instance-${binding.workspaceId}`,
      stop: async (binding) => {
        if (binding.workspaceId === "a") throw new Error("unit would not stop");
        await Bun.sleep(slowStopMs);
        slowStopFinished = true;
      },
      instance: async (binding) => `instance-${binding.workspaceId}`,
    },
  );
  await supervisor.recover();

  await expect(supervisor.shutdown()).rejects.toThrow("unit would not stop");
  expect(slowStopFinished).toBe(true);
});

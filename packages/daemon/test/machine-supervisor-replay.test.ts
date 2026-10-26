import { expect, test } from "bun:test";
import { MachineSupervisor, type ManagedBinding } from "#src/supervisor/machine-supervisor";

const binding = (workspaceId: string, enabled = true): ManagedBinding => ({
  workspaceId,
  computerId: "c",
  workspaceRoot: `/${workspaceId}`,
  enabled,
});

test("a replayed restart that answered early is under way only until its queued turn ends", async () => {
  let saved: ManagedBinding[] = [binding("a"), binding("b", false)];
  const running = new Map<string, string>([["a", "old"]]);
  const hold = Promise.withResolvers<void>();
  const starts: string[] = [];
  const supervisor = new MachineSupervisor(
    {
      load: async () => structuredClone(saved),
      save: async (next) => {
        saved = structuredClone(next);
      },
    },
    {
      instance: async (entry) => running.get(entry.workspaceId) ?? null,
      async start(entry) {
        const live = running.get(entry.workspaceId);
        if (live) return live;
        starts.push(entry.workspaceId);
        // Only Workspace b's start waits: it holds the queue the replay then waits in.
        if (entry.workspaceId === "b") await hold.promise;
        running.set(entry.workspaceId, `new-${starts.length}`);
        return `new-${starts.length}`;
      },
      stop: async (entry) => {
        running.delete(entry.workspaceId);
      },
    },
  );
  await supervisor.recover();
  await supervisor.command("restart", "a", "first");
  const adopted = (await supervisor.view())[0]?.instanceId;
  expect(starts).toEqual(["a"]);

  const blocker = supervisor.command("start", "b");
  const replay = await supervisor.command("restart", "a", "first", { deadline: Date.now() });
  // The replay answered while it was still queued, so the Workspace reads as under way ...
  expect(replay).toEqual({ started: [], pending: ["a"] });
  expect((await supervisor.view())[0]).toMatchObject({ workspaceId: "a", inFlight: true });

  hold.resolve();
  await blocker;
  await supervisor.snapshot();
  // ... and once its turn has run nothing is left under way and nothing was started again.
  expect((await supervisor.view())[0]).toMatchObject({
    workspaceId: "a",
    instanceId: adopted,
    inFlight: false,
  });
  expect(starts).toEqual(["a", "b"]);
});

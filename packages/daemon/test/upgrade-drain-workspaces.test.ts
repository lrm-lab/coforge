import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonHoldResponse } from "@lrm/coforge-sdk/internal";
import { MachineSupervisor } from "#src/supervisor/machine-supervisor";
import {
  UPGRADE_DRAIN_REQUEST_FILE,
  UPGRADE_DRAIN_STATE_FILE,
} from "#src/supervisor/upgrade-drain-watcher";
import { supervisorUpgradeDrainWatcher } from "#src/supervisor/upgrade-drain-workspaces";
import type { UpgradeWorkspaceInstance } from "#src/supervisor/workspace-instance";

const beta = { workspaceId: "beta", enabled: true, inFlight: false, startRevision: 0 };
const original = { mainPid: 42, active: true, invocationId: "beta-start" };
const idle: DaemonHoldResponse = {
  protocolMajor: 1,
  requestId: "fixture-rpc",
  accepted: true,
  held: true,
  busyAgents: [],
  unreachableWorkspaceIds: [],
};
const busy: DaemonHoldResponse = {
  ...idle,
  busyAgents: [{ workspaceId: "beta", agentId: "agent", detailKind: "turn", busySinceMs: 1 }],
};
const refused = { ...idle, accepted: false };

async function fixture(
  run: (
    input: {
      read: () => Promise<{ drainId: string; busyCount: number; updatedAtMs: number }>;
      request: (drainId: string) => Promise<unknown>;
      advance: (ms: number) => void;
      released: string[][];
    },
    create: (
      options: Partial<Parameters<typeof supervisorUpgradeDrainWatcher>[0]>,
    ) => ReturnType<typeof supervisorUpgradeDrainWatcher>,
  ) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "coforge-upgrade-workspaces-"));
  let now = 1_760_000_000_000;
  const released: string[][] = [];
  const request = (drainId: string) =>
    Bun.write(
      join(dir, UPGRADE_DRAIN_REQUEST_FILE),
      JSON.stringify({
        schemaVersion: 1,
        drainId,
        reason: "upgrade",
        requestedAtMs: now,
        deadlineAtMs: now + 150_000,
      }),
    );
  const state = Bun.file(join(dir, UPGRADE_DRAIN_STATE_FILE));
  try {
    await request("drain");
    await run(
      { read: () => state.json(), request, advance: (ms) => (now += ms), released },
      (options) =>
        supervisorUpgradeDrainWatcher({
          stateDirectory: dir,
          installRoot: dir,
          now: () => now,
          bindings: () => [beta],
          observe: async () => original,
          hold: async () => idle,
          release: async (ids) => {
            released.push([...ids]);
          },
          ...options,
        }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a live workspace missing one hold receipt keeps the same upgrade drain waiting", async () => {
  await fixture(async ({ read }, create) => {
    const sequence = [busy, refused, busy, idle];
    const watcher = create({ hold: async () => sequence.shift()! });
    for (const busyCount of [1, 1, 1, 0]) {
      await watcher.pollOnce();
      expect(await read()).toMatchObject({ drainId: "drain", held: true, busyCount });
    }
  });
});

test("an initial native query timeout publishes a pending state and keeps its heartbeat", async () => {
  await fixture(async ({ read, advance }, create) => {
    const queryStarted = Promise.withResolvers<void>();
    const noObservation = new Promise<UpgradeWorkspaceInstance>(() => {});
    const watcher = create({
      observe: () => {
        queryStarted.resolve();
        return noObservation;
      },
      hold: async () => {
        throw new Error("an unobserved process cannot be held");
      },
    });
    const first = watcher.pollOnce();
    await queryStarted.promise;
    const early = await read();
    expect(early).toMatchObject({ drainId: "drain", held: true, busyCount: 1 });
    await first;
    advance(1_000);
    await watcher.pollOnce();
    expect(await read()).toMatchObject({
      drainId: "drain",
      held: true,
      busyCount: 1,
      updatedAtMs: early.updatedAtMs + 1_000,
    });
  });
});

test("an initial RPC hold timeout never publishes zero for the live process", async () => {
  await fixture(async ({ read }, create) => {
    const holdStarted = Promise.withResolvers<void>();
    const noReceipt = new Promise<DaemonHoldResponse>(() => {});
    const watcher = create({
      hold: () => {
        holdStarted.resolve();
        return noReceipt;
      },
    });
    const first = watcher.pollOnce();
    await holdStarted.promise;
    expect(await read()).toMatchObject({ drainId: "drain", held: true, busyCount: 1 });
    await first;
    expect(await read()).toMatchObject({ drainId: "drain", held: true, busyCount: 1 });
  });
});

test("a late receipt for a replaced drain cannot publish zero", async () => {
  await fixture(async ({ read, request }, create) => {
    const holdStarted = Promise.withResolvers<void>();
    const late = Promise.withResolvers<DaemonHoldResponse>();
    let hold = () => {
      holdStarted.resolve();
      return late.promise;
    };
    const watcher = create({ hold: () => hold() });
    const first = watcher.pollOnce();
    await holdStarted.promise;
    await request("replacement");
    late.resolve(idle);
    await first;
    expect(await read()).toMatchObject({ drainId: "drain", busyCount: 1 });
    hold = async () => refused;
    await watcher.pollOnce();
    expect(await read()).toMatchObject({ drainId: "replacement", busyCount: 1 });
    hold = async () => idle;
    await watcher.pollOnce();
    expect(await read()).toMatchObject({ drainId: "replacement", busyCount: 0 });
  });
});

test.each([42, 43])(
  "a changed native invocation discards the receipt before asking PID %i again",
  async (pid) => {
    await fixture(async ({ read }, create) => {
      let instance = original;
      const heldPids: number[] = [];
      const watcher = create({
        observe: async () => instance,
        hold: async (_id, _reason, processId) => {
          heldPids.push(processId);
          instance = { mainPid: pid, active: true, invocationId: "beta-replacement" };
          return idle;
        },
      });
      await watcher.pollOnce();
      expect(await read()).toMatchObject({ busyCount: 1 });
      await watcher.pollOnce();
      expect(await read()).toMatchObject({ busyCount: 0 });
      expect(heldPids).toEqual([original.mainPid, pid]);
    });
  },
);

test("native exit and explicit stop let idle drain, but a starting workspace stays pending", async () => {
  await fixture(async ({ read, advance, released }, create) => {
    let instance: UpgradeWorkspaceInstance = original;
    let binding = beta;
    const watcher = create({
      bindings: () => [binding],
      observe: async () => instance,
      hold: async () => {
        instance = null;
        return refused;
      },
    });
    await watcher.pollOnce();
    expect(await read()).toMatchObject({ busyCount: 0 });
    binding = { ...beta, inFlight: true };
    await watcher.pollOnce();
    expect(await read()).toMatchObject({ busyCount: 1 });
    binding = { ...beta, enabled: false };
    await watcher.pollOnce();
    expect(await read()).toMatchObject({ busyCount: 0 });
    advance(150_000);
    await watcher.pollOnce();
    expect(released).toEqual([["beta"]]);
    await expect(read()).rejects.toThrow();
  });
});

test.each(["starts", "is registered"])(
  "a Workspace that %s during the final native query keeps the drain pending",
  async (mode) => {
    await fixture(async ({ read }, create) => {
      let bindings = [beta];
      let observations = 0;
      const watcher = create({
        bindings: () => bindings,
        observe: async () => {
          if (++observations === 2) {
            bindings =
              mode === "starts"
                ? [{ ...beta, inFlight: true }]
                : [beta, { ...beta, workspaceId: "alpha", inFlight: true }];
          }
          return null;
        },
      });
      await watcher.pollOnce();
      expect(await read()).toMatchObject({ busyCount: 1 });
    });
  },
);

test("a Workspace that starts and settles between parallel native reads needs a fresh hold", async () => {
  await fixture(async ({ read }, create) => {
    const alphaReading = Promise.withResolvers<void>();
    const releaseAlpha = Promise.withResolvers<void>();
    const betaRead = Promise.withResolvers<void>();
    const instances = new Map<string, string>();
    const supervisor = new MachineSupervisor(
      {
        load: async () =>
          ["alpha", "beta"].map((workspaceId) => ({
            workspaceId,
            computerId: "computer",
            workspaceRoot: `/${workspaceId}`,
            enabled: true,
          })),
        save: async () => {},
      },
      {
        start: async ({ workspaceId }) => {
          const instanceId = `${workspaceId}-instance`;
          instances.set(workspaceId, instanceId);
          return instanceId;
        },
        stop: async ({ workspaceId }) => {
          instances.delete(workspaceId);
        },
        instance: async ({ workspaceId }) => instances.get(workspaceId) ?? null,
      },
    );
    await supervisor.recover();
    const initial = supervisor.bindingView();
    await supervisor.reconcile();
    expect(supervisor.bindingView()).toEqual(initial);
    instances.delete("beta");
    let alphaReads = 0;
    let betaReads = 0;
    const held: number[] = [];
    const watcher = create({
      bindings: () => supervisor.bindingView(),
      observe: async (id) => {
        if (id === "alpha") {
          if (++alphaReads === 2) {
            alphaReading.resolve();
            await releaseAlpha.promise;
          }
          return null;
        }
        const seen = instances.has("beta") ? original : null;
        if (++betaReads === 2) betaRead.resolve();
        return seen;
      },
      hold: async (_id, _reason, pid) => {
        held.push(pid);
        return idle;
      },
    });
    const first = watcher.pollOnce();
    await Promise.all([alphaReading.promise, betaRead.promise]);
    await supervisor.reconcile(["beta"]);
    releaseAlpha.resolve();
    await first;
    expect(await read()).toMatchObject({ busyCount: 1 });
    expect(held).toEqual([]);
    await watcher.pollOnce();
    expect(held).toEqual([original.mainPid]);
    expect(await read()).toMatchObject({ busyCount: 0 });
  });
});

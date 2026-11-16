import { describe, expect, test } from "bun:test";
import { daemonRuntimeReadyPorts } from "#src/server/centrifugo/daemon-runtime-ready-composition.server";

type Entry = { channel: string; data: Uint8Array };

/** The composition reads Redis-backed stores at build time; the tests never reach them. */
function withRedisUrl<T>(run: () => Promise<T>): Promise<T> {
  const previous = Bun.env.REDIS_URL;
  Bun.env.REDIS_URL = previous ?? "redis://127.0.0.1:6379";
  return run().finally(() => {
    if (previous === undefined) delete Bun.env.REDIS_URL;
    else Bun.env.REDIS_URL = previous;
  });
}

function ports(input: {
  agents: { id: string }[];
  snapshotForDaemon: (request: { agentId: string }) => Promise<Uint8Array>;
  batches: Entry[][];
}) {
  return daemonRuntimeReadyPorts({
    db: { agent: { findMany: async () => input.agents } } as never,
    centrifugo: {
      publish: async () => undefined,
      publishBatch: async (entries: unknown[]) => {
        input.batches.push(entries as Entry[]);
        return entries.map(() => ({ status: "fulfilled", value: undefined }));
      },
    } as never,
    reminders: { snapshotForDaemon: input.snapshotForDaemon } as never,
    agentRepository: undefined as never,
    directConversations: undefined as never,
    mentionReports: undefined as never,
    sessions: undefined as never,
    control: undefined as never,
    controlStore: undefined as never,
    agentRuntimeLock: undefined as never,
    capabilityLeases: undefined as never,
    computerLifecycle: undefined as never,
  });
}

describe("daemon runtime ready composition", () => {
  test("publishes one reminder snapshot per assigned Agent in one batch", async () => {
    await withRedisUrl(async () => {
      const batches: Entry[][] = [];
      const composition = ports({
        agents: [{ id: "agent-1" }, { id: "agent-2" }],
        snapshotForDaemon: async ({ agentId }) => Uint8Array.of(agentId === "agent-1" ? 1 : 2),
        batches,
      });
      const reminderRecovery = composition?.reminderRecovery;
      if (!reminderRecovery) throw new Error("reminder recovery port was not composed");

      await reminderRecovery.snapshotAssigned("workspace-1", "computer-1");

      expect(batches).toHaveLength(1);
      expect(batches[0]).toEqual([
        { channel: "daemon:workspace-1:computer-1", data: Uint8Array.of(1) },
        { channel: "daemon:workspace-1:computer-1", data: Uint8Array.of(2) },
      ]);
    });
  });

  /** The push runs inside the ready handshake: a rejection there keeps the Daemon from ever being
   * ready, so one Agent the daemon may not see has to be skipped rather than abort the rest. */
  test("an Agent the daemon may not see is skipped, and the rest are still pushed", async () => {
    await withRedisUrl(async () => {
      const batches: Entry[][] = [];
      const composition = ports({
        agents: [{ id: "agent-1" }, { id: "unreachable" }],
        snapshotForDaemon: async ({ agentId }) => {
          if (agentId === "unreachable") throw new Error("reminder snapshot is not authorized");
          return Uint8Array.of(1);
        },
        batches,
      });
      const reminderRecovery = composition?.reminderRecovery;
      if (!reminderRecovery) throw new Error("reminder recovery port was not composed");

      await reminderRecovery.snapshotAssigned("workspace-1", "computer-1");

      expect(batches).toEqual([
        [{ channel: "daemon:workspace-1:computer-1", data: Uint8Array.of(1) }],
      ]);
    });
  });
});

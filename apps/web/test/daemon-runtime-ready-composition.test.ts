import { describe, expect, test } from "bun:test";
import { daemonRuntimeReadyPorts } from "#src/server/centrifugo/daemon-runtime-ready-composition.server";

describe("daemon runtime ready composition", () => {
  test("publishes reminder snapshots in one batch", async () => {
    const previousRedisUrl = Bun.env.REDIS_URL;
    Bun.env.REDIS_URL = previousRedisUrl ?? "redis://127.0.0.1:6379";
    try {
      const batches: unknown[][] = [];
      const publishes: unknown[] = [];
      const ports = daemonRuntimeReadyPorts({
        db: {
          agent: {
            findMany: async () => [
              { id: "agent-1", ownerId: "user-1" },
              { id: "agent-2", ownerId: "user-2" },
            ],
          },
        } as never,
        centrifugo: {
          publish: async (...args: unknown[]) => {
            publishes.push(args);
          },
          publishBatch: async (entries: unknown[]) => {
            batches.push(entries);
            return entries.map(() => ({ status: "fulfilled", value: undefined }));
          },
        } as never,
        reminders: {
          snapshot: async ({ agentId }: { agentId: string }) =>
            Uint8Array.of(agentId === "agent-1" ? 1 : 2),
        } as never,
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
      if (!ports) throw new Error("daemon runtime ready ports were not composed");
      const reminderRecovery = ports.reminderRecovery;
      if (!reminderRecovery) throw new Error("reminder recovery port was not composed");

      await reminderRecovery.snapshotAssigned("workspace-1", "computer-1");

      expect(publishes).toHaveLength(0);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(2);
      expect(batches[0]![0]).toMatchObject({
        channel: "daemon:workspace-1:computer-1",
        data: Uint8Array.of(1),
      });
      expect(batches[0]![1]).toMatchObject({
        channel: "daemon:workspace-1:computer-1",
        data: Uint8Array.of(2),
      });
    } finally {
      if (previousRedisUrl === undefined) delete Bun.env.REDIS_URL;
      else Bun.env.REDIS_URL = previousRedisUrl;
    }
  });
});

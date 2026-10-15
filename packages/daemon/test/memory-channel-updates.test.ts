import { expect, test } from "bun:test";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { MemoryChannelUpdates } from "#src/daemon-runtime/memory-channel-updates";

const message = (sequence: number, target = "#team") =>
  ({
    agentId: "memory",
    conversationId: "room",
    target,
    sequence,
    deliveryId: `delivery-${target}-${sequence}`,
    messageId: `message-${sequence}`,
  }) as AgentMessageDelivery;

test("five distinct updates produce one notification; a retry does not count twice", async () => {
  const batches: number[][] = [];
  const updates = new MemoryChannelUpdates(async (batch) => {
    batches.push(batch.map((m) => m.sequence));
  });
  await updates.add(message(1));
  await updates.add(message(1));
  for (const sequence of [2, 3, 4]) await updates.add(message(sequence));
  expect(batches).toEqual([]);
  await updates.add(message(5));
  expect(batches).toEqual([[1, 2, 3, 4, 5]]);
  updates.clearAgent("memory");
});

test("a quiet target is notified at 30 seconds, independently of another target", async () => {
  const timers: { callback: () => Promise<void>; milliseconds: number; cancelled: boolean }[] = [];
  const batches: string[][] = [];
  const updates = new MemoryChannelUpdates(
    async (batch) => {
      batches.push(batch.map((m) => m.target!));
    },
    {
      schedule(callback, milliseconds) {
        const timer = { callback, milliseconds, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    },
  );
  await updates.add(message(1));
  await updates.add(message(2));
  await updates.add(message(3, "#other"));
  expect(timers.map((t) => t.milliseconds)).toEqual([30_000, 30_000]);
  await timers[0]!.callback();
  expect(batches).toEqual([["#team", "#team"]]);
  updates.clearAgent("memory");
  expect(timers[1]!.cancelled).toBe(true);
});

test("a failed notice is retained for retry without losing later updates", async () => {
  const timers: (() => Promise<void>)[] = [];
  const batches: number[][] = [];
  let failed = false;
  const updates = new MemoryChannelUpdates(
    async (batch) => {
      if (!failed) {
        failed = true;
        throw new Error("notification refused");
      }
      batches.push(batch.map((m) => m.sequence).sort());
    },
    {
      schedule(callback) {
        timers.push(callback);
        return () => {};
      },
    },
  );
  for (const sequence of [1, 2, 3, 4]) await updates.add(message(sequence));
  await expect(updates.add(message(5))).rejects.toThrow("notification refused");
  await updates.add(message(6));
  expect(batches).toEqual([[1, 2, 3, 4, 5, 6]]);
  updates.clearAgent("memory");
});

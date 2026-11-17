import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { noticeExternalInbox } from "#src/server/agents/external-inbox-landing.server";

function fakeDb(rows: { agentId: string; pushable: boolean }[]) {
  let queries = 0;
  const db = {
    $queryRaw: async () => {
      queries++;
      return rows;
    },
  } as unknown as PrismaClient;
  return { db, count: () => queries };
}

function deps() {
  const woken: string[] = [];
  const enqueued: string[] = [];
  return {
    woken,
    enqueued,
    notify: (agentId: string) => woken.push(agentId),
    enqueueNotice: async (agentId: string) => {
      enqueued.push(agentId);
    },
  };
}

const message = { conversationId: "c1", messageId: "m1" };

test("a message landing wakes each external Agent once and enqueues a notice only for a pushable one", async () => {
  const { db, count } = fakeDb([
    { agentId: "a", pushable: true },
    { agentId: "b", pushable: false },
  ]);
  const d = deps();
  await noticeExternalInbox(db, message, d);
  expect(d.woken).toEqual(["a", "b"]);
  expect(d.enqueued).toEqual(["a"]);
  expect(count()).toBe(1);
});

test("a conversation with no external Agent signals nothing", async () => {
  const d = deps();
  await noticeExternalInbox(fakeDb([]).db, message, d);
  expect(d.woken).toEqual([]);
  expect(d.enqueued).toEqual([]);
});

test("a failing lookup or enqueue never throws into the write path", async () => {
  const failing = {
    $queryRaw: async () => {
      throw new Error("down");
    },
  } as unknown as PrismaClient;
  const d = deps();
  await noticeExternalInbox(failing, message, d);
  const { db } = fakeDb([{ agentId: "a", pushable: true }]);
  await noticeExternalInbox(db, message, {
    ...d,
    enqueueNotice: async () => {
      throw new Error("queue down");
    },
  });
  expect(d.woken).toEqual(["a"]);
});

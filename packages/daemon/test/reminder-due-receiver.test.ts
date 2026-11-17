import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REMINDER_DUE_MESSAGE_TYPE,
  type ReminderDue,
  type ReminderDueAckRequest,
} from "@lrm/coforge-sdk/internal";
import { ReminderDueReceiver } from "#src/agent-reminder/reminder-due-receiver";
import { FileReminderDueStore } from "#src/persistence/reminder-due-store";

const scope = {
  workspaceId: "019b0381-1111-7111-8111-111111111111",
  computerId: "019b0381-2222-7222-8222-222222222222",
};
const agentId = "019b0381-3333-7333-8333-333333333333";
const FIRE_AT = Date.parse("2026-11-17T00:00:00.000Z");

function due(occurrence = "4", version = 7): ReminderDue {
  return {
    protocolMajor: 1,
    ...scope,
    agentId,
    occurrenceId: `019b0381-444${occurrence}-7444-8444-444444444444`,
    job: {
      reminderId: "019b0381-5555-7555-8555-555555555555",
      ownerAgentId: agentId,
      version,
      title: "Check the build",
      target: "#engineering",
      messageId: "019b0381-6666-7666-8666-666666666666",
      fireAt: new Date(FIRE_AT).toISOString(),
    },
    expiresAt: new Date(FIRE_AT + 7 * 24 * 3_600_000).toISOString(),
    messageType: REMINDER_DUE_MESSAGE_TYPE,
  };
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function harness(options: { ack?: (request: ReminderDueAckRequest) => boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "reminder-due-"));
  directories.push(directory);
  const store = new FileReminderDueStore(directory, scope.workspaceId, scope.computerId);
  const clock = { nowMs: FIRE_AT + 1_000 };
  const acks: { request: ReminderDueAckRequest; persisted: string[] }[] = [];
  const delivered: { version: number; late: boolean }[] = [];
  let failDeliveries = 0;
  const build = () =>
    new ReminderDueReceiver(scope, store, {
      acknowledge: async (request) => {
        const persisted = (await store.read(request.agentId)).map((record) => record.state);
        acks.push({ request, persisted });
        return options.ack ? options.ack(request) : true;
      },
      deliver: async (job, occurrence) => {
        if (failDeliveries-- > 0) throw new Error("app inbox write failed");
        delivered.push({ version: job.version, late: occurrence.late });
      },
      now: () => clock.nowMs,
    });
  return {
    directory,
    store,
    clock,
    acks,
    delivered,
    build,
    failNextDelivery: () => (failDeliveries = 1),
    states: async () => (await store.read(agentId)).map((record) => record.state),
  };
}

test("a Due is on disk before its ACK, then delivered once and recorded as delivered", async () => {
  const h = harness();
  await h.build().receive(due());
  expect(h.acks).toHaveLength(1);
  expect(h.acks[0]!.persisted).toEqual(["received"]);
  expect(h.acks[0]!.request).toMatchObject({
    ...scope,
    agentId,
    occurrenceId: due().occurrenceId,
    reminderId: due().job.reminderId,
    version: 7,
  });
  expect(h.delivered).toEqual([{ version: 7, late: false }]);
  expect(await h.states()).toEqual(["delivered"]);
});

test("a repeated Due only repeats its ACK, and never a second item or wake", async () => {
  const h = harness();
  const receiver = h.build();
  await receiver.receive(due());
  await receiver.receive(due());
  await h.build().receive(due());
  expect(h.acks).toHaveLength(3);
  expect(h.delivered).toHaveLength(1);
});

test("a lost ACK delivers nothing until the republished Due is acknowledged", async () => {
  const h = harness();
  let reachable = false;
  const receiver = new ReminderDueReceiver(scope, h.store, {
    acknowledge: async () => {
      if (!reachable) throw new Error("connection closed");
      return true;
    },
    deliver: async (job) => void h.delivered.push({ version: job.version, late: false }),
    now: () => h.clock.nowMs,
  });
  await receiver.receive(due());
  expect(h.delivered).toHaveLength(0);
  expect(await h.states()).toEqual(["received"]);
  reachable = true;
  await receiver.receive(due());
  expect(h.delivered).toHaveLength(1);
  expect(await h.states()).toEqual(["delivered"]);
});

test("a daemon that stopped between the disk write and the ACK acknowledges and delivers on restore", async () => {
  const h = harness();
  await h.store.write(agentId, [{ state: "received", due: due() }]);
  await h.build().restore();
  expect(h.acks).toHaveLength(1);
  expect(h.delivered).toHaveLength(1);
  expect(await h.states()).toEqual(["delivered"]);
});

test("an acknowledged Due whose delivery failed is delivered by the next restore, without another ACK", async () => {
  const h = harness();
  h.failNextDelivery();
  await expect(h.build().receive(due())).rejects.toThrow("app inbox write failed");
  expect(await h.states()).toEqual(["acknowledged"]);
  h.clock.nowMs = Date.parse(due().expiresAt) + 1;
  await h.build().restore();
  expect(h.acks).toHaveLength(1);
  expect(h.delivered).toEqual([{ version: 7, late: true }]);
  expect(await h.states()).toEqual([]);
});

test("a Due the server refuses is never delivered, and its repeats are ignored", async () => {
  const h = harness({ ack: () => false });
  const receiver = h.build();
  await receiver.receive(due());
  await receiver.receive(due());
  expect(h.acks).toHaveLength(1);
  expect(h.delivered).toHaveLength(0);
  expect(await h.states()).toEqual(["refused"]);
});

test("an expired Due neither wakes nor is acknowledged", async () => {
  const h = harness();
  h.clock.nowMs = Date.parse(due().expiresAt);
  await h.build().receive(due());
  expect(h.acks).toHaveLength(0);
  expect(h.delivered).toHaveLength(0);
  expect(await h.states()).toEqual([]);
});

test("a Due for another Computer is not this daemon's", async () => {
  const h = harness();
  const foreign = { ...due(), computerId: "019b0381-7777-7777-8777-777777777777" };
  await h.build().receive(foreign);
  expect(h.acks).toHaveLength(0);
  expect(h.delivered).toHaveLength(0);
});

test("a later occurrence of the same reminder is its own delivery, and the late flag is measured locally", async () => {
  const h = harness();
  const receiver = h.build();
  await receiver.receive(due("4", 7));
  h.clock.nowMs = FIRE_AT + 61_000;
  await receiver.receive(due("5", 8));
  expect(h.delivered).toEqual([
    { version: 7, late: false },
    { version: 8, late: true },
  ]);
  expect(await receiver.isDelivered(agentId, due().job.reminderId, 8)).toBe(true);
  expect(await receiver.isDelivered(agentId, due().job.reminderId, 9)).toBe(false);
});

test("the store refuses a corrupt file and a record from another scope", async () => {
  const h = harness();
  const path = join(h.directory, "reminder-due", scope.workspaceId, agentId);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "occurrences.json"), JSON.stringify({ version: 1, occurrences: [{}] }));
  await expect(h.store.read(agentId)).rejects.toThrow("corrupt");
  const other = "019b0381-8888-7888-8888-888888888888";
  await expect(h.store.write(other, [{ state: "received", due: due() }])).rejects.toThrow(
    "another scope",
  );
  expect(await h.store.agents()).toEqual([agentId]);
});

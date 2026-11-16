import { expect, test } from "bun:test";
import { ReminderAcknowledgementSync } from "#src/agent-reminder/reminder-acknowledgement-sync";

const request = {
  agentId: "agent-a",
  reminderId: "123e4567-e89b-42d3-a456-426614174000",
  version: 3,
  operation: "ack" as const,
  idempotencyKey: "05240dae-bef2-548c-ac72-f4e84ed524d0",
};

test("a failed acknowledgement sync retries with the same idempotency key", async () => {
  let attempts = 0;
  const timers: Array<() => void> = [];
  const sent: string[] = [];
  const sync = new ReminderAcknowledgementSync(
    async (value) => {
      attempts++;
      sent.push(value.idempotencyKey);
      if (attempts === 1) throw new Error("offline");
    },
    (callback) => timers.push(callback),
  );
  sync.enqueue(request);
  await Promise.resolve();
  await Promise.resolve();
  expect(attempts).toBe(1);
  expect(timers).toHaveLength(1);
  timers.shift()!();
  await Promise.resolve();
  await Promise.resolve();
  expect(attempts).toBe(2);
  expect(sent).toEqual([request.idempotencyKey, request.idempotencyKey]);
});

test("duplicate enqueue calls coalesce while a sync is pending", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  let attempts = 0;
  const sync = new ReminderAcknowledgementSync(async () => {
    attempts++;
    await pending;
  });
  sync.enqueue(request);
  sync.enqueue(request);
  await Promise.resolve();
  expect(attempts).toBe(1);
  release();
});

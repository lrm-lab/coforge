import { expect, test } from "bun:test";
import {
  decodeReminderDue,
  encodeReminderDue,
  decodeReminderDueAckRequest,
  encodeReminderDueAckRequest,
  REMINDER_DUE_MESSAGE_TYPE,
} from "../src/internal/reminder-due";

const identity = {
  protocolMajor: 1,
  workspaceId: "019b0381-1111-7111-8111-111111111111",
  computerId: "019b0381-2222-7222-8222-222222222222",
  agentId: "019b0381-3333-7333-8333-333333333333",
};
const occurrenceId = "019b0381-4444-7444-8444-444444444444";
const job = {
  reminderId: "019b0381-5555-7555-8555-555555555555",
  ownerAgentId: identity.agentId,
  version: 7,
  title: "Check the build",
  target: "#engineering",
  messageId: "019b0381-6666-7666-8666-666666666666",
  fireAt: "2026-11-17T00:00:00.000Z",
};
const due = {
  ...identity,
  occurrenceId,
  job,
  expiresAt: "2026-11-24T00:00:00.000Z",
  messageType: REMINDER_DUE_MESSAGE_TYPE,
};

test("Due preserves the immutable fired revision independently of plan sync", () => {
  expect(decodeReminderDue(encodeReminderDue(due))).toEqual(due);
});

test("Due rejects another Agent's job and an unsupported protocol", () => {
  expect(() =>
    encodeReminderDue({ ...due, job: { ...job, ownerAgentId: identity.computerId } }),
  ).toThrow();
  expect(() => encodeReminderDue({ ...due, protocolMajor: 2 })).toThrow();
});

test("Due validates occurrence, revision and expiration at the boundary", () => {
  expect(() => encodeReminderDue({ ...due, occurrenceId: "" })).toThrow();
  expect(() => encodeReminderDue({ ...due, job: { ...job, version: 0 } })).toThrow();
  expect(() => encodeReminderDue({ ...due, expiresAt: "yesterday" })).toThrow();
  expect(() => decodeReminderDue(new Uint8Array(65_537))).toThrow();
});

test("transport ACK carries the exact occurrence and revision", () => {
  const ack = {
    ...identity,
    occurrenceId,
    requestId: "due-ack-1",
    reminderId: job.reminderId,
    version: job.version,
  };
  expect(decodeReminderDueAckRequest(encodeReminderDueAckRequest(ack))).toEqual(ack);
  expect(() => encodeReminderDueAckRequest({ ...ack, version: 0 })).toThrow();
});

import { expect, test } from "bun:test";
import {
  decodeReminderDue,
  decodeReminderDueV2,
  encodeReminderDue,
  REMINDER_DUE_CAPABILITY,
  REMINDER_DUE_MESSAGE_TYPE,
  REMINDER_DUE_V2_CAPABILITY,
  type ReminderTriggerDue,
} from "../src/internal/reminder-due";

const identity = {
  protocolMajor: 1,
  workspaceId: "019b0381-1111-7111-8111-111111111111",
  computerId: "019b0381-2222-7222-8222-222222222222",
  agentId: "019b0381-3333-7333-8333-333333333333",
};
const reminderId = "019b0381-5555-7555-8555-555555555555";
const triggerJob = {
  kind: "trigger" as const,
  reminderId,
  ownerAgentId: identity.agentId,
  version: 1,
  title: "CI is red",
  target: `reminder:${reminderId}`,
  triggerKey: "ci.red",
  details: "3 jobs failed",
  fireAt: "2026-11-17T00:00:00.000Z",
};
const due: ReminderTriggerDue = {
  ...identity,
  occurrenceId: "019b0381-4444-7444-8444-444444444444",
  job: triggerJob,
  expiresAt: "2026-11-24T00:00:00.000Z",
  messageType: REMINDER_DUE_MESSAGE_TYPE,
};

test("the v2 capability is its own name, apart from v1", () => {
  expect(REMINDER_DUE_V2_CAPABILITY).toBe("reminder-due:v2");
  expect(REMINDER_DUE_V2_CAPABILITY).not.toBe(REMINDER_DUE_CAPABILITY);
});

test("a trigger Due round-trips with its key and details and no message anchor", () => {
  const decoded = decodeReminderDueV2(encodeReminderDue(due));
  expect(decoded).toEqual(due);
  expect("messageId" in decoded.job).toBe(false);
});

test("a trigger Due without details round-trips without them", () => {
  const { details: _details, ...withoutDetails } = triggerJob;
  const bare = { ...due, job: withoutDetails };
  expect(decodeReminderDueV2(encodeReminderDue(bare))).toEqual(bare);
});

test("a trigger job is refused when its shape is wrong", () => {
  const encode = (job: Record<string, unknown>) => encodeReminderDue({ ...due, job: job as never });
  expect(() => encode({ ...triggerJob, triggerKey: "" })).toThrow();
  expect(() => encode({ ...triggerJob, triggerKey: "bad key" })).toThrow();
  expect(() => encode({ ...triggerJob, target: "#general" })).toThrow();
  expect(() => encode({ ...triggerJob, target: "reminder:other" })).toThrow();
  expect(() => encode({ ...triggerJob, messageId: reminderId })).toThrow();
  expect(() => encode({ ...triggerJob, details: "x".repeat(4097) })).toThrow();
  expect(() => encode({ ...triggerJob, title: "" })).toThrow();
  expect(() => encode({ ...triggerJob, ownerAgentId: identity.computerId })).toThrow();
});

test("a scheduled job still needs its message anchor and takes no trigger fields", () => {
  const scheduled = {
    reminderId,
    ownerAgentId: identity.agentId,
    version: 1,
    title: "Check the build",
    target: "#engineering",
    messageId: "019b0381-6666-7666-8666-666666666666",
    fireAt: "2026-11-17T00:00:00.000Z",
  };
  expect(decodeReminderDueV2(encodeReminderDue({ ...due, job: scheduled } as never)).job).toEqual(
    scheduled,
  );
  expect(() =>
    encodeReminderDue({ ...due, job: { ...scheduled, messageId: "" } as never }),
  ).toThrow();
  expect(() =>
    encodeReminderDue({ ...due, job: { ...scheduled, triggerKey: "ci.red" } as never }),
  ).toThrow();
});

test("the v1 decoder refuses a trigger Due instead of delivering it as a scheduled reminder", () => {
  expect(() => decodeReminderDue(encodeReminderDue(due))).toThrow();
});

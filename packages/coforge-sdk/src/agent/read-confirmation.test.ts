import { expect, test } from "bun:test";
import {
  AGENT_READ_PROTOCOL,
  agentReadCheckpointSchema,
  agentReadConfirmationSchema,
  agentReadPageRequestSchema,
  agentReadPageResponseSchema,
} from "./read-confirmation";

const checkpoint = { index: 1, through: 1, messageId: "message-1", proof: "A".repeat(43) };
const confirm = { page: "header.signature", checkpoints: [checkpoint] };
const window = {
  messages: [
    { id: "message-1", sequence: 1 },
    { id: "message-2", sequence: 2 },
  ],
  hasOlder: false,
  hasNewer: false,
};
const page = {
  protocol: AGENT_READ_PROTOCOL,
  readThrough: 0,
  window,
  receipt: {
    ...confirm,
    checkpoints: [checkpoint, { ...checkpoint, index: 2, through: 2, messageId: "message-2" }],
  },
};

test("message and task share a fetch that can carry an explicit previous confirmation", () => {
  expect(
    agentReadPageRequestSchema.parse({
      source: { kind: "message", target: "#general" },
      window: { unread: true, limit: 2 },
      confirm,
    }),
  ).toMatchObject({ confirm });
  expect(
    agentReadPageRequestSchema.safeParse({
      source: { kind: "task", channel: "#general", taskNumber: 7 },
      window: { around: "message-1", consume: false },
    }).success,
  ).toBe(true);
});

test("legacy pages and an output tail without its earlier checkpoint cannot confirm consumption", () => {
  expect(agentReadPageResponseSchema.safeParse(window).success).toBe(false);
  expect(
    agentReadConfirmationSchema.safeParse({
      ...confirm,
      checkpoints: [{ ...checkpoint, index: 2, through: 2, messageId: "message-2" }],
    }).success,
  ).toBe(false);
  expect(agentReadCheckpointSchema.safeParse({ ...checkpoint, proof: "unfinished" }).success).toBe(
    false,
  );
  expect(agentReadPageResponseSchema.safeParse(page).success).toBe(true);
  expect(
    agentReadPageResponseSchema.safeParse({
      ...page,
      receipt: { ...confirm, checkpoints: [checkpoint] },
    }).success,
  ).toBe(false);
});

test("pure view omits receipts and contradictory anchors are rejected", () => {
  expect(agentReadPageResponseSchema.safeParse({ ...page, receipt: undefined }).success).toBe(true);
  expect(
    agentReadPageRequestSchema.safeParse({
      source: { kind: "message", target: "#general" },
      window: { unread: true, around: "1" },
    }).success,
  ).toBe(false);
});

import { expect, test } from "bun:test";
import { legacyAgentTaskRequestSchema } from "./agent-task-request";

const request = { operation: "create", idempotencyKey: "original-key", title: "A task" };

test("the legacy Task POST accepts the stripped request with its original idempotency key", () => {
  expect(legacyAgentTaskRequestSchema.parse(request)).toEqual(request);
  expect(
    legacyAgentTaskRequestSchema.safeParse({ ...request, consumptionEvidence: [] }).success,
  ).toBe(false);
});

test("stripping consumption evidence does not make another invalid Task POST retryable", () => {
  expect(legacyAgentTaskRequestSchema.safeParse({ ...request, status: "done" }).success).toBe(
    false,
  );
  expect(legacyAgentTaskRequestSchema.safeParse({ ...request, idempotencyKey: "" }).success).toBe(
    false,
  );
  expect(legacyAgentTaskRequestSchema.safeParse({ ...request, unknownField: 1 }).success).toBe(
    false,
  );
});

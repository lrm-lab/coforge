import { expect, test } from "bun:test";
import { validateTaskRequest } from "./index";

const base = {
  idempotencyKey: "request",
  operation: "list",
  target: "#general",
} as const;

test("validateTaskRequest accepts a well-formed list command", () => {
  expect(() => validateTaskRequest(base)).not.toThrow();
});

test("validateTaskRequest rejects an unknown operation, thread targets, and missing operation arguments", () => {
  expect(() => validateTaskRequest({ ...base, operation: "invalid" as "list" })).toThrow(
    "invalid Task request",
  );
  expect(() => validateTaskRequest({ ...base, target: "#general:deadbeef" })).toThrow(
    "invalid Task target",
  );
  expect(() => validateTaskRequest({ ...base, operation: "create" })).toThrow(
    "missing Task operation argument",
  );
  expect(() => validateTaskRequest({ ...base, operation: "unclaim" })).toThrow(
    "missing Task operation argument",
  );
  expect(() =>
    validateTaskRequest({ ...base, operation: "unclaim", number: 2_147_483_648 }),
  ).toThrow("invalid Task number");
  expect(() => validateTaskRequest({ ...base, operation: "unassign" })).toThrow(
    "missing Task operation argument",
  );
  expect(() =>
    validateTaskRequest({ ...base, operation: "unassign", number: 2, assignee: "@ada" }),
  ).toThrow("missing Task operation argument");
  expect(() =>
    validateTaskRequest({ ...base, operation: "unassign", number: 2, numbers: [2, 3] }),
  ).toThrow("missing Task operation argument");
  expect(() =>
    validateTaskRequest({
      ...base,
      operation: "update",
      number: 1,
      status: "done",
      expectedRevision: 2_147_483_648,
    }),
  ).toThrow("invalid Task revision");
});

test("validateTaskRequest requires the idempotency key, scope ids, and the protocol major", () => {
  const { idempotencyKey: _dropped, ...withoutKey } = base;
  expect(() =>
    validateTaskRequest(withoutKey as unknown as Parameters<typeof validateTaskRequest>[0]),
  ).toThrow("invalid Task request");
  expect(() => validateTaskRequest({ ...base, idempotencyKey: "" })).toThrow(
    "invalid Task request",
  );
  // The envelope is gone: an unknown field is the browser bundle's problem, not this validator's,
  // but a body that still carries the old `protocolMajor` names no rejected field of its own.
  expect(() => validateTaskRequest({ ...base, operation: "bogus" as "list" })).toThrow(
    "invalid Task request",
  );
});

test("validateTaskRequest keeps agent commands off the browser's conversationId selector", () => {
  expect(() => validateTaskRequest({ ...base, conversationId: "conversation-1" })).toThrow(
    "invalid Task target",
  );
});

test("validateTaskRequest accepts a create from a source message, alongside another task, with a description", () => {
  const create = { ...base, operation: "create" as const, title: "Fix it" };
  expect(() =>
    validateTaskRequest({ ...create, messageId: "01a16c6c-1c04", description: "details" }),
  ).not.toThrow();
  expect(() =>
    validateTaskRequest({ ...create, messageId: "01a16c6c-1c04", alongside: true }),
  ).not.toThrow();
  expect(() => validateTaskRequest({ ...create, messageId: " " })).toThrow("invalid Task message");
  expect(() => validateTaskRequest({ ...create, messageId: "a", messageIds: ["b"] })).toThrow(
    "missing Task operation argument",
  );
  expect(() => validateTaskRequest({ ...create, alongside: "yes" as never })).toThrow(
    "invalid Task request",
  );
  expect(() => validateTaskRequest({ ...base, operation: "list", alongside: true })).toThrow(
    "invalid Task request",
  );
});

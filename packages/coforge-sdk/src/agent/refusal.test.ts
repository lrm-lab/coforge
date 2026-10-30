import { expect, test } from "bun:test";

import { decodeAgentApiRefusal } from "./refusal";

test("a refusal may carry details of strings and numbers", () => {
  const body = { error: "conflict", code: "CONFLICT", details: { taskNumber: 7, holder: "atlas" } };
  expect(decodeAgentApiRefusal(body)).toEqual(body);
});

test("details that are not a flat record of strings and numbers are not a refusal", () => {
  for (const details of ["x", [1], { nested: { a: 1 } }, { flag: true }, null])
    expect(decodeAgentApiRefusal({ error: "conflict", details })).toBeUndefined();
});

test("any other extra field still makes it not a refusal", () => {
  expect(decodeAgentApiRefusal({ error: "conflict", extra: 1 })).toBeUndefined();
});

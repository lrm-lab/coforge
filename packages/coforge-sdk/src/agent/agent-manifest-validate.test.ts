import { expect, test } from "bun:test";

import { AGENT_MANIFEST_SCHEMA_KEYWORDS } from "./agent-manifest-types";
import { validateAgainstSchema } from "./agent-manifest-validate";

const messages = (schema: Record<string, unknown>, value: unknown) =>
  validateAgainstSchema(schema, value).map((p) => `${p.path}: ${p.message}`);

test("a conforming value has no problems", () => {
  const schema = {
    type: "object",
    properties: { id: { type: "string", minLength: 1 }, n: { type: "integer", minimum: 0 } },
    required: ["id"],
  };
  expect(messages(schema, { id: "a", n: 2 })).toEqual([]);
});

test("required, type, and additionalProperties:false are reported with a JSON Pointer", () => {
  const schema = {
    type: "object",
    properties: { id: { type: "string" }, tags: { type: "array", items: { type: "integer" } } },
    required: ["id"],
    additionalProperties: false,
  };
  expect(messages(schema, { tags: [1, "x", 2.5], extra: 1 })).toEqual([
    "/id: is required",
    "/tags/1: must be an integer",
    "/tags/2: must be an integer",
    "/extra: is not an allowed property",
  ]);
});

test("enum, const, bounds, lengths and item counts", () => {
  expect(messages({ enum: ["a", "b"] }, "c")).toHaveLength(1);
  expect(messages({ const: 3 }, 4)).toHaveLength(1);
  expect(messages({ type: "number", minimum: 1, maximum: 2 }, 3)).toHaveLength(1);
  expect(messages({ type: "number", minimum: 1 }, 0)).toHaveLength(1);
  expect(messages({ type: "string", minLength: 2, maxLength: 3 }, "a")).toHaveLength(1);
  expect(messages({ type: "string", maxLength: 1 }, "ab")).toHaveLength(1);
  expect(messages({ type: "array", minItems: 2 }, [1])).toHaveLength(1);
  expect(messages({ type: "array", maxItems: 1 }, [1, 2])).toHaveLength(1);
  expect(messages({ type: "number" }, Number.NaN)).toHaveLength(1);
  expect(messages({ type: "null" }, null)).toEqual([]);
  expect(messages({ type: "object" }, [])).toHaveLength(1);
});

test("pattern and format are never executed", () => {
  expect(messages({ type: "string", pattern: "^(a+)+$", format: "email" }, "aaaa!")).toEqual([]);
});

test("a schema is not trusted: inherited keys are not read", () => {
  expect(messages({ type: "object", properties: {} }, JSON.parse('{"__proto__": 1}'))).toEqual([]);
});

test("the number of problems is capped", () => {
  const value = Array.from({ length: 200 }, () => "x");
  expect(validateAgainstSchema({ type: "array", items: { type: "integer" } }, value)).toHaveLength(
    50,
  );
});

/** Keywords the checker accepts but the validator never executes: they describe, or (`pattern`,
 * `format`) are left to the app, since CoForge runs no manifest-supplied regular expression. */
const DESCRIPTIVE_ONLY = ["description", "title", "default", "pattern", "format"];

test("every accepted schema keyword is enforced or listed as descriptive only", () => {
  const enforced = {
    type: [{ type: "string" }, 1],
    properties: [{ type: "object", properties: { a: { type: "string" } } }, { a: 1 }],
    required: [{ type: "object", required: ["a"] }, {}],
    items: [{ type: "array", items: { type: "string" } }, [1]],
    enum: [{ enum: ["a"] }, "b"],
    const: [{ const: "a" }, "b"],
    minimum: [{ minimum: 1 }, 0],
    maximum: [{ maximum: 1 }, 2],
    minLength: [{ minLength: 2 }, "a"],
    maxLength: [{ maxLength: 1 }, "ab"],
    minItems: [{ minItems: 1 }, []],
    maxItems: [{ maxItems: 0 }, [1]],
    additionalProperties: [{ type: "object", additionalProperties: false }, { a: 1 }],
  } as const satisfies Record<string, readonly [Record<string, unknown>, unknown]>;
  for (const keyword of AGENT_MANIFEST_SCHEMA_KEYWORDS) {
    if (DESCRIPTIVE_ONLY.includes(keyword)) continue;
    const [schema, value] = enforced[keyword as keyof typeof enforced];
    expect({ keyword, problems: validateAgainstSchema(schema, value).length > 0 }).toEqual({
      keyword,
      problems: true,
    });
  }
});

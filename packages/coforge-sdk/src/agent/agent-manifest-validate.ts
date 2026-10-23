import { isRecord } from "#src/internal/json-record";
import { pointer } from "./agent-manifest-schema-subset";
import { AGENT_MANIFEST_LIMITS, type AgentManifestProblem } from "./agent-manifest-types";

/**
 * Checks `value` against a schema of the manifest's JSON Schema subset (`type`, `properties`,
 * `required`, `items`, `enum`, `const`, `minimum`, `maximum`, `minLength`, `maxLength`,
 * `minItems`, `maxItems`, `additionalProperties`). `pattern` and `format` are never executed:
 * CoForge does not run a manifest-supplied regular expression, and the app validates its own
 * input. Pure. Returns at most `maxProblems` problems, each at a JSON Pointer into `value`.
 */
export function validateAgainstSchema(schema: unknown, value: unknown): AgentManifestProblem[] {
  const problems: AgentManifestProblem[] = [];
  const add = (path: string, message: string) => {
    if (problems.length < AGENT_MANIFEST_LIMITS.maxProblems) problems.push({ path, message });
  };
  check(schema, value, "", add);
  return problems;
}

type Add = (path: string, message: string) => void;

const TYPE_NAMES: Record<string, string> = {
  string: "a string",
  integer: "an integer",
  number: "a number",
  boolean: "a boolean",
  object: "an object",
  array: "an array",
  null: "null",
};

function hasType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

const own = (node: Record<string, unknown>, key: string) =>
  Object.hasOwn(node, key) ? node[key] : undefined;

function check(schema: unknown, value: unknown, path: string, add: Add): void {
  if (!isRecord(schema)) return;
  const type = own(schema, "type");
  if (typeof type === "string" && !hasType(type, value)) {
    add(path, `must be ${TYPE_NAMES[type] ?? type}`);
    return;
  }
  const enumeration = own(schema, "enum");
  if (Array.isArray(enumeration) && !enumeration.includes(value))
    add(path, `must be one of ${JSON.stringify(enumeration)}`);
  if (Object.hasOwn(schema, "const") && schema.const !== value)
    add(path, `must equal ${JSON.stringify(schema.const)}`);
  if (typeof value === "number") {
    const { minimum, maximum } = schema;
    if (typeof minimum === "number" && value < minimum) add(path, `must be at least ${minimum}`);
    if (typeof maximum === "number" && value > maximum) add(path, `must be at most ${maximum}`);
  }
  if (typeof value === "string") {
    const length = [...value].length;
    const { minLength, maxLength } = schema;
    if (typeof minLength === "number" && length < minLength)
      add(path, `must have at least ${minLength} characters`);
    if (typeof maxLength === "number" && length > maxLength)
      add(path, `must have at most ${maxLength} characters`);
  }
  if (Array.isArray(value)) {
    const { minItems, maxItems } = schema;
    if (typeof minItems === "number" && value.length < minItems)
      add(path, `must have at least ${minItems} items`);
    if (typeof maxItems === "number" && value.length > maxItems)
      add(path, `must have at most ${maxItems} items`);
    const items = own(schema, "items");
    if (items !== undefined)
      value.forEach((item, index) => check(items, item, pointer(path, index), add));
  }
  if (isRecord(value) && !Array.isArray(value)) checkObject(schema, value, path, add);
}

function checkObject(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  path: string,
  add: Add,
): void {
  const properties = own(schema, "properties");
  const declared = isRecord(properties) ? properties : {};
  const required = own(schema, "required");
  if (Array.isArray(required))
    for (const name of required)
      if (typeof name === "string" && !Object.hasOwn(value, name))
        add(pointer(path, name), "is required");
  for (const [name, item] of Object.entries(value)) {
    if (Object.hasOwn(declared, name)) check(declared[name], item, pointer(path, name), add);
    else if (schema.additionalProperties === false)
      add(pointer(path, name), "is not an allowed property");
  }
}

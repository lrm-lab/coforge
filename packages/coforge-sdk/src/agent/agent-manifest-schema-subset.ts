import { isRecord } from "#src/internal/json-record";
import {
  AGENT_MANIFEST_LIMITS as LIMITS,
  AGENT_MANIFEST_SCHEMA_KEYWORDS,
  AGENT_MANIFEST_SCHEMA_TYPES,
  type AgentManifestSchemaNode,
} from "./agent-manifest-types";

/** Records one problem at a JSON Pointer; the parser caps how many it keeps. */
export type ReportProblem = (path: string, message: string) => void;

export const pointer = (base: string, key: string | number) =>
  `${base}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;

/** Reports every key of `value` that is neither in `allowed` nor an `x-` extension. */
export function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  report: ReportProblem,
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key) && !key.startsWith("x-"))
      report(pointer(path, key), `unknown field "${key}"`);
}

const RESERVED_NAMES = ["__proto__", "constructor", "prototype"];
const isPrimitive = (value: unknown) =>
  value === null || ["string", "number", "boolean"].includes(typeof value);
const isCount = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0;

type Walk = { nodes: number; tooDeep: boolean; tooMany: boolean; report: ReportProblem };

function walkNode(
  value: unknown,
  path: string,
  depth: number,
  walk: Walk,
): AgentManifestSchemaNode | undefined {
  if (!isRecord(value)) {
    walk.report(path, "must be a schema object");
    return undefined;
  }
  if (depth > LIMITS.schemaMaxDepth) {
    walk.tooDeep = true;
    return undefined;
  }
  if (++walk.nodes > LIMITS.schemaMaxNodes) {
    walk.tooMany = true;
    return undefined;
  }
  const { report } = walk;
  rejectUnknownKeys(value, AGENT_MANIFEST_SCHEMA_KEYWORDS, path, report);
  const out: AgentManifestSchemaNode = {};
  for (const keyword of AGENT_MANIFEST_SCHEMA_KEYWORDS) {
    if (!(keyword in value)) continue;
    const item = value[keyword];
    const at = pointer(path, keyword);
    out[keyword] = item;
    switch (keyword) {
      case "type":
        if (!(AGENT_MANIFEST_SCHEMA_TYPES as readonly unknown[]).includes(item))
          report(at, `must be one of ${AGENT_MANIFEST_SCHEMA_TYPES.join(", ")}`);
        break;
      case "description":
      case "title": {
        const max = keyword === "title" ? LIMITS.schemaTitleMaxLength : LIMITS.descriptionMaxLength;
        if (typeof item !== "string" || item.length > max)
          report(at, `must be a string of at most ${max} characters`);
        break;
      }
      case "format":
        if (
          typeof item !== "string" ||
          item.length < 1 ||
          item.length > LIMITS.schemaFormatMaxLength
        )
          report(at, `must be a string of 1 to ${LIMITS.schemaFormatMaxLength} characters`);
        break;
      case "pattern":
        if (typeof item !== "string" || item.length > LIMITS.schemaPatternMaxLength)
          report(at, `must be a string of at most ${LIMITS.schemaPatternMaxLength} characters`);
        else
          try {
            new RegExp(item, "u"); // compiled to check it, never run: a pattern is descriptive
          } catch {
            report(at, "must be a valid regular expression");
          }
        break;
      case "minimum":
      case "maximum":
        if (typeof item !== "number" || !Number.isFinite(item)) report(at, "must be a number");
        break;
      case "minLength":
      case "maxLength":
      case "minItems":
      case "maxItems":
        if (!isCount(item)) report(at, "must be a non-negative integer");
        break;
      case "additionalProperties":
        if (typeof item !== "boolean") report(at, "must be a boolean");
        break;
      case "const":
      case "default":
        if (!isPrimitive(item)) report(at, "must be a string, number, boolean or null");
        break;
      case "enum":
        if (!Array.isArray(item) || item.length < 1 || item.length > LIMITS.schemaMaxEnum)
          report(at, `must be a list of 1 to ${LIMITS.schemaMaxEnum} values`);
        else if (!item.every(isPrimitive))
          report(at, "values must be strings, numbers, booleans or null");
        break;
      case "items":
        out.items = walkNode(item, at, depth + 1, walk);
        break;
      case "properties":
        if (!isRecord(item)) report(at, "must be an object of schemas");
        else if (Object.keys(item).length > LIMITS.schemaMaxProperties)
          report(at, `at most ${LIMITS.schemaMaxProperties} properties`);
        else {
          const props: Record<string, unknown> = Object.create(null);
          for (const [name, child] of Object.entries(item)) {
            if (name.length < 1 || name.length > LIMITS.schemaPropertyNameMaxLength)
              report(
                pointer(at, name),
                `property names are 1 to ${LIMITS.schemaPropertyNameMaxLength} characters`,
              );
            if (RESERVED_NAMES.includes(name))
              report(pointer(at, name), `the property name "${name}" is reserved`);
            props[name] = walkNode(child, pointer(at, name), depth + 1, walk);
          }
          out.properties = props;
        }
        break;
      case "required": {
        const names = new Set(isRecord(value.properties) ? Object.keys(value.properties) : []);
        if (!Array.isArray(item) || !item.every((name) => typeof name === "string"))
          report(at, "must be a list of property names");
        else if (new Set(item).size !== item.length) report(at, "names must be unique");
        else if (item.some((name) => !names.has(name)))
          report(at, "every required name must be a declared property");
        break;
      }
    }
  }
  return out;
}

/** Checks a value against the bounded JSON Schema subset and returns it without `x-` keys. A root
 * that must describe an object (an action's input) is checked with `rootObject`. */
export function checkSchemaSubset(
  value: unknown,
  path: string,
  report: ReportProblem,
  rootObject: boolean,
): AgentManifestSchemaNode | undefined {
  const walk: Walk = { nodes: 0, tooDeep: false, tooMany: false, report };
  const node = walkNode(value, path, 1, walk);
  if (walk.tooDeep) report(path, `schema depth exceeds ${LIMITS.schemaMaxDepth}`);
  if (walk.tooMany) report(path, `schema has more than ${LIMITS.schemaMaxNodes} nodes`);
  if (rootObject && node && node.type !== "object")
    report(pointer(path, "type"), 'the root must have type "object"');
  return node;
}

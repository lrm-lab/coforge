/**
 * Wire contract for `coforge label list`: the Workspace's labels, each with its group, its
 * archived state, and how many Tasks carry it. The route returns every label, archived ones
 * included, so an Agent can see a name is taken even after it was archived.
 */

import { isRecord } from "../internal";

/** A label's group as the list carries it; `selection` is the group's `single|multiple` rule. */
export type AgentLabelGroup = {
  id: string;
  name: string;
  nameKey: string;
  selection: string;
};

/** One Workspace label as `label list` shows it. `color` is a Badge semantic color key. */
export type AgentLabel = {
  id: string;
  name: string;
  color: string;
  description: string | null;
  groupId: string | null;
  archivedAt: string | null;
  group: AgentLabelGroup | null;
  /** Open Tasks carrying the label. */
  openCount: number;
  /** All Tasks carrying the label. */
  taskCount: number;
  /** When the label was last attached to a Task. */
  lastUsedAt: string | null;
};

/** A label as a write answers with it: the row, without the list's counts. */
export type AgentLabelRecord = Omit<AgentLabel, "openCount" | "taskCount" | "lastUsedAt">;

/**
 * `POST /api/agent/v1/labels` (task #508): `coforge label create` makes a label (an Agent must say
 * what it is for, and a name already taken answers with that label); `rename`, `update --color`,
 * `delete` (archive) and `restore` are one `update` of the label named `label`, which only a
 * Workspace owner or admin may make, as on the web page.
 */
export type AgentLabelWriteRequest =
  | { operation: "create"; name: string; description: string; color?: string }
  | { operation: "update"; label: string; name?: string; color?: string; archived?: boolean };

/** Response for `POST /api/agent/v1/labels`: the label as it now is. */
export type AgentLabelWriteResponse = { ok: true; label: AgentLabelRecord };

/** Each operation's fields: required strings, optional strings, optional booleans. */
const WRITE_FIELDS = {
  create: { required: ["name", "description"], strings: ["color"], booleans: [] },
  update: { required: ["label"], strings: ["name", "color"], booleans: ["archived"] },
} as const satisfies Record<
  AgentLabelWriteRequest["operation"],
  { required: readonly string[]; strings: readonly string[]; booleans: readonly string[] }
>;

/** A label write with exactly its operation's fields, an update changing at least one; else null. */
export function decodeAgentLabelWriteRequest(value: unknown): AgentLabelWriteRequest | null {
  if (!isRecord(value) || Array.isArray(value)) return null;
  const operation = value.operation;
  if (operation !== "create" && operation !== "update") return null;
  const fields: {
    required: readonly string[];
    strings: readonly string[];
    booleans: readonly string[];
  } = WRITE_FIELDS[operation];
  for (const [key, field] of Object.entries(value)) {
    if (key === "operation") continue;
    if (fields.required.includes(key) || fields.strings.includes(key)) {
      if (typeof field !== "string") return null;
    } else if (fields.booleans.includes(key)) {
      if (typeof field !== "boolean") return null;
    } else return null;
  }
  if (fields.required.some((key) => value[key] === undefined)) return null;
  if (operation === "update" && Object.keys(value).length < 3) return null;
  return value as AgentLabelWriteRequest;
}

export function decodeAgentLabelWriteResponse(value: unknown): AgentLabelWriteResponse {
  if (!isRecord(value) || value.ok !== true || !isLabelRecord(value.label))
    throw new Error("invalid Agent label write response");
  return { ok: true, label: value.label };
}

/** Response for `GET /api/agent/v1/labels`, alphabetical by name. */
export type AgentLabelListResponse = {
  ok: true;
  labels: AgentLabel[];
};

function isLabelGroup(value: unknown): value is AgentLabelGroup {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.nameKey === "string" &&
    typeof value.selection === "string"
  );
}

function isLabelRecord(value: unknown): value is AgentLabelRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.color === "string" &&
    (value.description === null || typeof value.description === "string") &&
    (value.groupId === null || typeof value.groupId === "string") &&
    (value.archivedAt === null || typeof value.archivedAt === "string") &&
    (value.group === null || isLabelGroup(value.group))
  );
}

function isLabel(value: unknown): value is AgentLabel {
  if (!isLabelRecord(value)) return false;
  const counts = value as Record<string, unknown>;
  return (
    typeof counts.openCount === "number" &&
    typeof counts.taskCount === "number" &&
    (counts.lastUsedAt === null || typeof counts.lastUsedAt === "string")
  );
}

export function decodeAgentLabelListResponse(value: unknown): AgentLabelListResponse {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.labels))
    throw new Error("invalid Agent label list response");
  if (!value.labels.every(isLabel)) throw new Error("invalid Agent label list response");
  return { ok: true, labels: value.labels };
}

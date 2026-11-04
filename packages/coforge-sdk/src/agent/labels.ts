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

function isLabel(value: unknown): value is AgentLabel {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.color === "string" &&
    (value.description === null || typeof value.description === "string") &&
    (value.groupId === null || typeof value.groupId === "string") &&
    (value.archivedAt === null || typeof value.archivedAt === "string") &&
    (value.group === null || isLabelGroup(value.group)) &&
    typeof value.openCount === "number" &&
    typeof value.taskCount === "number" &&
    (value.lastUsedAt === null || typeof value.lastUsedAt === "string")
  );
}

export function decodeAgentLabelListResponse(value: unknown): AgentLabelListResponse {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.labels))
    throw new Error("invalid Agent label list response");
  if (!value.labels.every(isLabel)) throw new Error("invalid Agent label list response");
  return { ok: true, labels: value.labels };
}

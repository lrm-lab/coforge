/**
 * Wire contract for `coforge label list`: the Workspace's labels, each with its group, its
 * archived state, and how many Tasks carry it. The route returns every label, archived ones
 * included, so an Agent can see a name is taken even after it was archived.
 */

import { z } from "zod";

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

const labelWriteRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("create"),
    name: z.string(),
    description: z.string(),
    color: z.string().exactOptional(),
  }),
  z
    .strictObject({
      operation: z.literal("update"),
      label: z.string(),
      name: z.string().exactOptional(),
      color: z.string().exactOptional(),
      archived: z.boolean().exactOptional(),
    })
    .refine(
      (value) =>
        value.name !== undefined || value.color !== undefined || value.archived !== undefined,
    ),
]);

const labelGroupSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  nameKey: z.string(),
  selection: z.string(),
});

const labelRecordSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  description: z.string().nullable(),
  groupId: z.string().nullable(),
  archivedAt: z.string().nullable(),
  group: labelGroupSchema.nullable(),
});

const labelSchema = z.looseObject({
  ...labelRecordSchema.shape,
  openCount: z.number(),
  taskCount: z.number(),
  lastUsedAt: z.string().nullable(),
});

const labelWriteResponseSchema = z.object({
  ok: z.literal(true),
  label: labelRecordSchema,
});

const labelListResponseSchema = z.object({
  ok: z.literal(true),
  labels: z.array(labelSchema),
});

export function decodeAgentLabelWriteRequest(value: unknown): AgentLabelWriteRequest | null {
  const parsed = labelWriteRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function decodeAgentLabelWriteResponse(value: unknown): AgentLabelWriteResponse {
  const parsed = labelWriteResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid Agent label write response");
  return parsed.data;
}

/** Response for `GET /api/agent/v1/labels`, alphabetical by name. */
export type AgentLabelListResponse = {
  ok: true;
  labels: AgentLabel[];
};

export function decodeAgentLabelListResponse(value: unknown): AgentLabelListResponse {
  const parsed = labelListResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid Agent label list response");
  return parsed.data;
}

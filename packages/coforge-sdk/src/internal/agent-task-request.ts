import { z } from "zod";
import { agentConsumptionEvidenceSchema } from "./agent-consumption";
import { CHANNEL_NAME_PATTERN } from "./channel-references";
import { MAX_MESSAGE_SEQUENCE, SEEN_EXACT_SEQS_LIMIT } from "./freshness-decision";
import { PROJECT_SLUG_MAX_LENGTH } from "./project-slug";
import { TASK_PRIORITY_LEVELS } from "./task-order";
import { TASK_CREATE_STATUSES, TASK_READ_STATUSES, TASK_WRITE_STATUSES } from "./task-status";

const taskOperations = [
  "list",
  "show",
  "create",
  "convert",
  "claim",
  "unclaim",
  "update",
  "assign",
  "unassign",
  "amend",
  "history",
  "delete",
  "receipt",
] as const;
const taskStatuses = [...TASK_READ_STATUSES, "all"] as const;

const taskRefSchema = z
  .object({
    number: z.number().int().positive(),
    channel: z.string().regex(CHANNEL_NAME_PATTERN).optional(),
  })
  .strict();

const taskRequestFields = z
  .object({
    operation: z.enum(taskOperations),
    idempotencyKey: z.string().min(1),
    conversationId: z.uuid().optional(),
    target: z.string().min(1).optional(),
    peerKind: z.enum(["human", "agent"]).optional(),
    number: z.number().int().positive().optional(),
    numbers: z.array(z.number().int().positive()).min(1).optional(),
    messageId: z.string().min(1).optional(),
    messageIds: z.array(z.string().min(1)).min(1).optional(),
    title: z.string().min(1).max(10_000).optional(),
    titles: z.array(z.string().min(1).max(10_000)).min(1).optional(),
    description: z.string().max(50_000).nullable().optional(),
    assignee: z.string().nullable().optional(),
    reason: z.string().optional(),
    blockedBy: z.array(taskRefSchema).max(100).optional(),
    parent: taskRefSchema.nullable().optional(),
    ready: z.boolean().optional(),
    mine: z.boolean().optional(),
    createsResource: z.boolean().optional(),
    receipt: z
      .object({
        object: z.string().min(1),
        purpose: z.string().min(1),
        teardownOwner: z.string().min(1),
        securityPrivacy: z.string().min(1),
        expiry: z.iso.datetime({ offset: true }),
        runbook: z.string().min(1),
        tracking: z.string().min(1),
      })
      .optional(),
    freshnessContextMode: z.enum(["inline", "withheld"]).optional(),
    seenUpToSeq: z.number().int().nonnegative().max(MAX_MESSAGE_SEQUENCE).optional(),
    seenExactSeqs: z
      .array(z.number().int().positive().max(MAX_MESSAGE_SEQUENCE))
      .max(SEEN_EXACT_SEQS_LIMIT)
      .optional(),
    continueAnyway: z.boolean().optional(),
    alongside: z.boolean().optional(),
    attachmentId: z.uuid().optional(),
    status: z.enum(taskStatuses).optional(),
    statuses: z.array(z.enum(TASK_READ_STATUSES)).min(1).max(TASK_READ_STATUSES.length).optional(),
    priority: z.enum(TASK_PRIORITY_LEVELS).optional(),
    dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
    labels: z.array(z.string().min(1).max(64)).max(5).optional(),
    removeLabels: z.array(z.string().min(1).max(64)).max(5).optional(),
    labelDescription: z.string().min(1).max(500).optional(),
    project: z.string().trim().min(1).max(PROJECT_SLUG_MAX_LENGTH).nullable().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();

const legacyAgentTaskRequestOptions = [
  taskRequestFields.extend({ operation: z.literal("list") }),
  taskRequestFields.extend({
    operation: z.literal("create"),
    status: z.enum(TASK_CREATE_STATUSES).optional(),
  }),
  taskRequestFields.extend({
    operation: z.literal("update"),
    status: z.enum(TASK_READ_STATUSES).optional(),
  }),
  taskRequestFields.extend({
    operation: z.enum(
      taskOperations.filter(
        (operation) => operation !== "list" && operation !== "create" && operation !== "update",
      ),
    ),
    status: z.enum(TASK_WRITE_STATUSES).optional(),
  }),
] as const;

export const legacyAgentTaskRequestSchema = z.discriminatedUnion(
  "operation",
  legacyAgentTaskRequestOptions,
);

const scopedFields = { consumptionEvidence: agentConsumptionEvidenceSchema.optional() };
const [list, create, update, write] = legacyAgentTaskRequestOptions;
export const agentTaskRequestSchema = z.discriminatedUnion("operation", [
  list.extend(scopedFields),
  create.extend(scopedFields),
  update.extend(scopedFields),
  write.extend(scopedFields),
]);

import {
  isTaskRef,
  TASK_CREATE_STATUSES,
  TASK_PRIORITY_LEVELS,
  TASK_WRITE_STATUSES,
  TASK_READ_STATUSES,
  type TaskRef,
} from "@lrm/coforge-sdk/internal";
import { z } from "zod";

import { PROJECT_SLUG_MAX_LENGTH } from "#src/features/projects/projects.schemas";

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
  "restore",
  "receipt",
] as const;

const taskCommandFields = z
  .object({
    operation: z.enum(taskOperations),
    idempotencyKey: z.uuid(),
    conversationId: z.uuid(),
    target: z.never().optional(),
    number: z.number().int().positive().optional(),
    messageId: z.string().min(8).max(36).optional(),
    title: z.string().trim().min(1).max(8_000).optional(),
    titles: z.array(z.string().trim().min(1).max(8_000)).min(1).optional(),
    numbers: z.array(z.number().int().positive()).min(1).optional(),
    messageIds: z.array(z.string().min(8).max(36)).min(1).optional(),
    mine: z.boolean().optional(),
    blockedBy: z.array(z.custom<TaskRef>(isTaskRef)).max(100).optional(),
    parent: z.custom<TaskRef>(isTaskRef).nullable().optional(),
    labels: z.array(z.string().trim().min(1).max(32)).max(5).optional(),
    removeLabels: z.array(z.string().trim().min(1).max(32)).max(5).optional(),
    assignee: z.string().nullable().optional(),
    reason: z.string().optional(),
    description: z.string().max(50_000).nullable().optional(),
    project: z.string().trim().min(1).max(PROJECT_SLUG_MAX_LENGTH).nullable().optional(),
    createsResource: z.boolean().optional(),
    alongside: z.boolean().optional(),
    freshnessContextMode: z.enum(["inline", "withheld"]).optional(),
    receipt: z
      .object({
        object: z.string().min(1),
        purpose: z.string().min(1),
        teardownOwner: z.string().min(1),
        securityPrivacy: z.string().min(1),
        expiry: z.iso.datetime(),
        runbook: z.string().min(1),
        tracking: z.string().min(1),
      })
      .optional(),
    attachmentId: z.uuid().optional(),
    status: z.enum(TASK_READ_STATUSES).optional(),
    priority: z.enum(TASK_PRIORITY_LEVELS).optional(),
    dueAt: z.iso.datetime().nullable().optional(),
    dueHasTime: z.boolean().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();

export const taskCommand = z.discriminatedUnion("operation", [
  taskCommandFields.extend({ operation: z.literal("list") }),
  taskCommandFields.extend({
    operation: z.literal("create"),
    status: z.enum(TASK_CREATE_STATUSES).optional(),
  }),
  taskCommandFields.extend({
    operation: z.literal("update"),
    status: z.enum(TASK_WRITE_STATUSES).optional(),
  }),
  taskCommandFields.extend({
    operation: z.enum(
      taskOperations.filter(
        (operation) => operation !== "list" && operation !== "create" && operation !== "update",
      ),
    ),
    status: z.enum(TASK_WRITE_STATUSES).optional(),
  }),
]);

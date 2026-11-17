import {
  isTaskRef,
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

/** The shape of a Task command a person's page sends; the board validates what it means. */
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
    // Blockers and the parent (Tasks v2): the server's own validation decides what each may be.
    blockedBy: z.array(z.custom<TaskRef>(isTaskRef)).max(100).optional(),
    parent: z.custom<TaskRef>(isTaskRef).nullable().optional(),
    labels: z.array(z.string().trim().min(1).max(32)).max(5).optional(),
    removeLabels: z.array(z.string().trim().min(1).max(32)).max(5).optional(),
    assignee: z.string().nullable().optional(),
    description: z.string().max(50_000).nullable().optional(),
    // A Project's slug files the Task under it; null clears it, and the Task follows its channel.
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
    operation: z.enum(taskOperations.filter((operation) => operation !== "list")),
    status: z.enum(TASK_WRITE_STATUSES).optional(),
  }),
]);

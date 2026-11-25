import { z } from "zod";

export const ACTIVITY_INBOX_FILTERS = ["all", "unread", "mentions", "tasks", "artifacts"] as const;
export type ActivityInboxFilter = (typeof ACTIVITY_INBOX_FILTERS)[number];

const chronologicalCursorSchema = z.strictObject({
  at: z.number().int().min(0).max(253_402_300_799_999),
  sequence: z.number().int().min(0).max(2_147_483_647),
  key: z.string().min(1).max(64),
});
const unreadFirstCursorSchema = chronologicalCursorSchema.extend({
  order: z.literal("unread-first-v1"),
  hasUnread: z.boolean(),
});
export const activityInboxCursorSchema = z.union([
  unreadFirstCursorSchema,
  chronologicalCursorSchema,
]);
export type ActivityInboxCursor = z.infer<typeof activityInboxCursorSchema>;

export function activityCursorForFilter(
  filter: ActivityInboxFilter,
  cursor: ActivityInboxCursor | undefined,
): ActivityInboxCursor | undefined {
  if (cursor && "order" in cursor === (filter === "all")) return cursor;
  return undefined;
}

export const activityInboxPageSchema = z.object({
  filter: z.enum(ACTIVITY_INBOX_FILTERS),
  cursor: activityInboxCursorSchema.optional(),
  selectedKey: z.string().min(1).max(64).optional(),
});

export const ACTIVITY_MAX_TIME = Date.UTC(2100, 0, 1);

export const activityArtifactMarkSchema = z.object({
  kind: z.literal("artifact"),
  artifactId: z.uuid(),
  throughAt: z.number().int().min(0).max(ACTIVITY_MAX_TIME),
});
export type ActivityArtifactMark = z.infer<typeof activityArtifactMarkSchema>;

export const activityItemReadSchema = z.discriminatedUnion("kind", [activityArtifactMarkSchema]);
export type ActivityItemRead = z.infer<typeof activityItemReadSchema>;

export const activityItemDoneSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("conversation"),
    conversationId: z.uuid(),
    throughSequence: z.number().int().min(1),
  }),
  z.object({
    kind: z.literal("thread"),
    conversationId: z.uuid(),
    rootMessageId: z.uuid(),
    markedUnreadVersion: z.uuid().optional(),
    throughSequence: z.number().int().min(1),
  }),
  z.object({ kind: z.literal("mention_action"), resolutionId: z.uuid() }),
  activityArtifactMarkSchema,
]);
export type ActivityItemDone = z.infer<typeof activityItemDoneSchema>;

export const activityInboxReadAllSchema = z.object({
  before: z.number().int().positive().max(ACTIVITY_MAX_TIME),
});

export const activityMentionReadSchema = z.object({
  resolutionId: z.uuid(),
  read: z.boolean(),
});

export const ACTIVITY_UNDO_LIMIT = 5_000;

const timeSchema = z.number().int().min(0).max(ACTIVITY_MAX_TIME);

const sequenceSchema = z.number().int().min(1).max(2_147_483_647);

export const activityDoneUndoSchema = z.object({
  members: z
    .array(
      z.object({
        memberId: z.uuid(),
        previous: sequenceSchema.nullable(),
        through: sequenceSchema,
      }),
    )
    .max(ACTIVITY_UNDO_LIMIT),
  threads: z
    .array(
      z.object({
        memberId: z.uuid(),
        rootMessageId: z.uuid(),
        previous: sequenceSchema.nullable(),
        through: sequenceSchema,
      }),
    )
    .max(ACTIVITY_UNDO_LIMIT),
  mentions: z.object({
    ids: z.array(z.uuid()).max(ACTIVITY_UNDO_LIMIT),
    at: z.number().int().positive().max(8.64e15),
  }),
  artifacts: z
    .array(
      z.object({
        artifactId: z.uuid(),
        previousReadAt: timeSchema.nullable(),
        previousDoneAt: timeSchema.nullable(),
        through: timeSchema,
      }),
    )
    .max(ACTIVITY_UNDO_LIMIT)
    .default([]),
});
export type ActivityDoneUndo = z.infer<typeof activityDoneUndoSchema>;

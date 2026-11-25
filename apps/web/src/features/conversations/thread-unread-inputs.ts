import { MAX_MESSAGE_SEQUENCE } from "@lrm/coforge-sdk/internal";
import { z } from "zod";

export const THREAD_UNREAD_BATCH_LIMIT = 200;

const markSchema = z.object({ rootMessageId: z.uuid(), version: z.uuid() });
export type ThreadUnreadMark = z.infer<typeof markSchema>;

export const threadUnreadBatchInput = z.object({
  operationId: z.uuid(),
  throughSequence: z.number().int().min(0).max(MAX_MESSAGE_SEQUENCE),
  marks: z
    .array(markSchema)
    .max(THREAD_UNREAD_BATCH_LIMIT)
    .refine(
      (marks) => new Set(marks.map(({ rootMessageId }) => rootMessageId)).size === marks.length,
    ),
});

export type ThreadUnreadBatch = z.infer<typeof threadUnreadBatchInput>;

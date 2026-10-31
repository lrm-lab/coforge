import {
  publicationDataOrUndefined,
  publicationType,
} from "#src/features/realtime/publication-data";
import { z } from "zod";

/**
 * A report changed where its page cannot see it happen: its key points started, finished or
 * failed. Published on the own `chat:user:<user_id>` channel of each person who may read the report
 * (`reportReaders`), so a page showing it reads it again; like the other signals it carries only
 * the ids, and the read checks access as any read does.
 */
export type RecordChangedEvent = {
  type: "record.changed.v1";
  workspaceId: string;
  reportId: string;
};

const recordChangedEvent = z.object({
  type: z.literal("record.changed.v1"),
  workspaceId: z.string().min(1),
  reportId: z.string().min(1),
});

/** The event, or undefined for any other publication on the channel. */
export function decodeRecordChangedEvent(value: unknown): RecordChangedEvent | undefined {
  const data = publicationDataOrUndefined(value);
  if (publicationType(data) !== "record.changed.v1") return undefined;
  const parsed = recordChangedEvent.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

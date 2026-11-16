import { z } from "zod";
import {
  publicationDataOrUndefined,
  publicationType,
} from "#src/features/realtime/publication-data";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";

const eventDecoder =
  <Schema extends z.ZodType>(type: string, schema: Schema) =>
  (value: unknown): z.infer<Schema> | undefined => {
    const data = publicationDataOrUndefined(value);
    if (publicationType(data) !== type) return undefined;
    const parsed = schema.safeParse(data);
    return parsed.success ? parsed.data : undefined;
  };

const artifactEvent = <Type extends string, Shape extends z.ZodRawShape>(
  type: Type,
  shape: Shape,
) =>
  z.object({
    type: z.literal(type),
    workspaceId: z.string().min(1),
    artifactId: z.string().min(1),
    ...shape,
  });

const versionPublished = artifactEvent(REALTIME_EVENTS.artifactVersionPublished, {
  number: z.number().int().positive(),
});
const accessChanged = artifactEvent(REALTIME_EVENTS.artifactAccessChanged, {});
const dataChanged = artifactEvent(REALTIME_EVENTS.artifactDataChanged, {
  collection: z.string().min(1),
});
const commentsChanged = artifactEvent(REALTIME_EVENTS.artifactCommentsChanged, {
  change: z.enum(["posted", "edited", "deleted", "resolved", "reopened"]),
  commentIds: z.array(z.string().min(1)).max(100),
});

export type ArtifactVersionPublishedEvent = z.infer<typeof versionPublished>;
export type ArtifactAccessChangedEvent = z.infer<typeof accessChanged>;
export type ArtifactDataChangedEvent = z.infer<typeof dataChanged>;
export type ArtifactCommentsChangedEvent = z.infer<typeof commentsChanged>;

export const decodeArtifactVersionPublishedEvent = eventDecoder(
  REALTIME_EVENTS.artifactVersionPublished,
  versionPublished,
);
export const decodeArtifactAccessChangedEvent = eventDecoder(
  REALTIME_EVENTS.artifactAccessChanged,
  accessChanged,
);
export const decodeArtifactDataChangedEvent = eventDecoder(
  REALTIME_EVENTS.artifactDataChanged,
  dataChanged,
);
export const decodeArtifactCommentsChangedEvent = eventDecoder(
  REALTIME_EVENTS.artifactCommentsChanged,
  commentsChanged,
);

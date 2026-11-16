import { z } from "zod";
import {
  publicationDataOrUndefined,
  publicationType,
} from "#src/features/realtime/publication-data";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";

export type ArtifactVersionPublishedEvent = {
  type: "artifact.version.published.v1";
  workspaceId: string;
  artifactId: string;
  number: number;
};

const artifactVersionPublishedEvent = z.object({
  type: z.literal(REALTIME_EVENTS.artifactVersionPublished),
  workspaceId: z.string().min(1),
  artifactId: z.string().min(1),
  number: z.number().int().positive(),
});

export function decodeArtifactVersionPublishedEvent(
  value: unknown,
): ArtifactVersionPublishedEvent | undefined {
  const data = publicationDataOrUndefined(value);
  if (publicationType(data) !== REALTIME_EVENTS.artifactVersionPublished) return undefined;
  const parsed = artifactVersionPublishedEvent.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

export type ArtifactAccessChangedEvent = {
  type: "artifact.access.changed.v1";
  workspaceId: string;
  artifactId: string;
};

const artifactAccessChangedEvent = z.object({
  type: z.literal(REALTIME_EVENTS.artifactAccessChanged),
  workspaceId: z.string().min(1),
  artifactId: z.string().min(1),
});

export function decodeArtifactAccessChangedEvent(
  value: unknown,
): ArtifactAccessChangedEvent | undefined {
  const data = publicationDataOrUndefined(value);
  if (publicationType(data) !== REALTIME_EVENTS.artifactAccessChanged) return undefined;
  const parsed = artifactAccessChangedEvent.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

export type ArtifactDataChangedEvent = {
  type: "artifact.data.changed.v1";
  workspaceId: string;
  artifactId: string;
  collection: string;
};

const artifactDataChangedEvent = z.object({
  type: z.literal(REALTIME_EVENTS.artifactDataChanged),
  workspaceId: z.string().min(1),
  artifactId: z.string().min(1),
  collection: z.string().min(1),
});

export function decodeArtifactDataChangedEvent(
  value: unknown,
): ArtifactDataChangedEvent | undefined {
  const data = publicationDataOrUndefined(value);
  if (publicationType(data) !== REALTIME_EVENTS.artifactDataChanged) return undefined;
  const parsed = artifactDataChangedEvent.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

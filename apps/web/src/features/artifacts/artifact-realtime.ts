import { z } from "zod";
import {
  publicationDataOrUndefined,
  publicationType,
} from "#src/features/realtime/publication-data";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";

/**
 * A new version of an artifact was saved (task #385): to the pages of its home, a
 * conversation's (`chat:<conversationId>`) or, for a Workspace artifact, the Workspace's
 * (`chat:workspace:<id>`). It names the version and nothing of its content or publisher; an open
 * document reads the version itself ("X published version N", "View latest").
 */
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

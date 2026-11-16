import { z } from "zod";

import { FORWARD_DESTINATIONS_MAX } from "#src/features/conversations/message-forward";

export const ARTIFACT_SHARE_MAX_TARGETS = 20;
export const ARTIFACT_SHARE_NOTE_MAX_LENGTH = 500;

export const shareArtifactInputSchema = z
  .object({
    artifactId: z.uuid(),
    destinations: z
      .array(z.uuid())
      .min(1)
      .max(Math.min(FORWARD_DESTINATIONS_MAX, ARTIFACT_SHARE_MAX_TARGETS)),
    note: z.string().trim().max(ARTIFACT_SHARE_NOTE_MAX_LENGTH).optional(),
    requestId: z.uuid(),
    unseen: z.enum(["hold", "send"]).optional(),
  })
  .strict();

import { z } from "zod";

import { FORWARD_DESTINATIONS_MAX } from "#src/features/conversations/message-forward";

/** How much one artifact share request may carry: the service refuses more. */
export const ARTIFACT_SHARE_MAX_ARTIFACTS = 20;
export const ARTIFACT_SHARE_MAX_TARGETS = 20;
/** The note a share carries above its links. */
export const ARTIFACT_SHARE_NOTE_MAX_LENGTH = 500;

/**
 * A person's share from the web: one artifact, the conversations it goes to, an optional note
 * and the dialog's request id. There is no actor: the server function shares as the session's
 * person, and `strict` refuses any other field. The destinations are the Forward picker's
 * (`FORWARD_DESTINATIONS_MAX`, 10), within the service's cap.
 */
export const shareArtifactInputSchema = z
  .object({
    artifactId: z.uuid(),
    destinations: z
      .array(z.uuid())
      .min(1)
      .max(Math.min(FORWARD_DESTINATIONS_MAX, ARTIFACT_SHARE_MAX_TARGETS)),
    note: z.string().trim().max(ARTIFACT_SHARE_NOTE_MAX_LENGTH).optional(),
    requestId: z.uuid(),
  })
  .strict();

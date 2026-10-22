import { z } from "zod";

/** Private execution intent; never included in the browser's conversation metadata. */
export const piChatCheckpointSchema = z.object({
  requestId: z.uuid(),
  message: z.string().min(1).max(100_000),
  messageCount: z.number().int().nonnegative(),
  stopRequested: z.boolean().optional(),
  queued: z
    .array(
      z.object({
        id: z.uuid(),
        text: z.string().min(1).max(100_000),
        mode: z.enum(["steer", "followUp"]),
      }),
    )
    .max(20)
    .optional(),
});
export type PiChatCheckpoint = z.infer<typeof piChatCheckpointSchema>;

export class PiChatRecoveryUncertain extends Error {
  constructor() {
    super("A previous tool's outcome is uncertain; inspect it before continuing.");
  }
}

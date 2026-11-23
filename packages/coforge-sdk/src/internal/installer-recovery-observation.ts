import { z } from "zod";

const installerRecoverySampleSequence = z.int().min(1).max(0xffff_ffff);

export const installerRecoveryObservationSchema = z.union([
  z.strictObject({ requestChallenge: z.literal(true) }),
  z.strictObject({
    challenge: z.uuid(),
    required: z.boolean(),
    sampleSequence: installerRecoverySampleSequence,
  }),
]);

export const installerRecoveryChallengeSchema = z.object({
  token: z.uuid(),
  generation: installerRecoverySampleSequence,
});

export type InstallerRecoveryObservation = z.infer<typeof installerRecoveryObservationSchema>;
export type InstallerRecoveryChallenge = z.infer<typeof installerRecoveryChallengeSchema>;

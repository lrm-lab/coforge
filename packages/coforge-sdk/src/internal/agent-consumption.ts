import { z } from "zod";
import { MAX_MESSAGE_SEQUENCE, SEEN_EXACT_SEQS_LIMIT } from "./freshness-decision";

export const agentConsumptionScopeSchema = z.strictObject({
  conversationId: z.string().min(1),
  threadRootId: z.string().min(1).optional(),
});

export const agentConsumptionEvidenceSchema = z
  .array(
    z.strictObject({
      target: agentConsumptionScopeSchema,
      entry: z.strictObject({
        seq: z.number().int().nonnegative().max(MAX_MESSAGE_SEQUENCE).optional(),
        exactSeqs: z
          .array(z.number().int().positive().max(MAX_MESSAGE_SEQUENCE))
          .max(SEEN_EXACT_SEQS_LIMIT)
          .readonly()
          .optional(),
      }),
    }),
  )
  .readonly();

export type AgentConsumptionScope = z.infer<typeof agentConsumptionScopeSchema>;
export type AgentConsumptionEvidence = z.infer<typeof agentConsumptionEvidenceSchema>;

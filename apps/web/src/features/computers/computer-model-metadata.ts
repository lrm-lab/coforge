import type { CodeAgentModelMetadata } from "@lrm/coforge-sdk/internal";
import { z } from "zod";

/** Enough for the largest real window, small enough that a wild number is refused (task #30). */
export const MAX_MODEL_TOKENS = 10_000_000;

const modelSizeSchema = z.int().min(1).max(MAX_MODEL_TOKENS);

/** A stored size, or undefined for a zero, a fraction, anything above what a model could have, or
 * anything else no model has: a catalog written by an older build may carry none of these, and a
 * stale row may carry rubbish. */
export function modelSize(value: unknown): number | undefined {
  const parsed = modelSizeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const codeAgentModelMetadataSchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    description: z.string(),
    modelProvider: z.string(),
    reasoningEfforts: z.array(z.string()).optional(),
    defaultReasoning: z.string(),
    recommended: z.boolean(),
    contextWindow: z.unknown().optional(),
    maxOutputTokens: z.unknown().optional(),
  })
  .transform(
    ({ contextWindow, maxOutputTokens, reasoningEfforts, ...rest }): CodeAgentModelMetadata => {
      const parsedContextWindow = modelSize(contextWindow);
      const parsedMaxOutputTokens = modelSize(maxOutputTokens);
      return {
        ...rest,
        reasoningEfforts,
        ...(parsedContextWindow === undefined ? {} : { contextWindow: parsedContextWindow }),
        ...(parsedMaxOutputTokens === undefined ? {} : { maxOutputTokens: parsedMaxOutputTokens }),
      };
    },
  );

const codeAgentModelMetadataListSchema = z.array(codeAgentModelMetadataSchema);

export function modelMetadata(value: unknown): CodeAgentModelMetadata[] | undefined {
  const parsed = codeAgentModelMetadataListSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

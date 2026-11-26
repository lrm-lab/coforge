import { z } from "zod";

/**
 * The Agent API's explained refusal: the body a route answers when it refuses a request for a
 * reason the Agent can act on (`{ error, code, retryable }` from the Web route helper
 * `errorResponse`; a plain validation answer may carry `{ error }` alone). `error` is written for
 * the Agent; `code` is a stable UPPER_SNAKE code; `retryable` says whether the same request can
 * succeed later.
 */
export type AgentApiRefusal = {
  error: string;
  code?: string;
  retryable?: boolean;
  /** Facts a caller can act on without parsing `error` (a held task's number, who holds it). */
  details?: Record<string, string | number>;
};

const STABLE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

const agentApiRefusalSchema = z.strictObject({
  error: z.string().refine((value) => value.trim().length > 0),
  code: z.string().regex(STABLE_CODE).optional(),
  retryable: z.boolean().optional(),
  details: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

export function decodeAgentApiRefusal(value: unknown): AgentApiRefusal | undefined {
  const parsed = agentApiRefusalSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

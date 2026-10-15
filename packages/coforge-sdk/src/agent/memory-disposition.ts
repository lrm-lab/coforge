/** A receipt is an authenticated target's intent, never evidence of execution. */
export const MEMORY_DISPOSITION_TOOL = "memory_disposition" as const;
export const MEMORY_DECISIONS = ["adopt", "reject", "defer"] as const;
export type MemoryDecision = (typeof MEMORY_DECISIONS)[number];

export type MemoryHintDelivery = {
  hint_id: string;
  tool: typeof MEMORY_DISPOSITION_TOOL;
};

export type MemoryDispositionRequest = {
  hint_id: string;
  decision: MemoryDecision;
  reason: string;
  intended_action_refs?: string[];
};

export type MemoryDispositionRecord = {
  hint_id: string;
  target_agent_id: string;
  decision: MemoryDecision;
  reason: string;
  intended_action_refs: string[];
  decided_at: string;
  skipped_source_refs: string[];
};

export type MemoryDispositionResult =
  | { ok: true; record: MemoryDispositionRecord; duplicate: boolean }
  | {
      ok: false;
      error: {
        code: "invalid_argument" | "unauthorized" | "terminal" | "expired" | "not_actionable";
        source_refs?: string[];
      };
    };

/** Validate the public shape before consulting any Hint or caller permissions.
 * Empty reason is checked only after target authentication and replay checks. */
export function decodeMemoryDispositionRequest(value: unknown): MemoryDispositionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid memory disposition");
  const input = value as Record<string, unknown>;
  const allowed = new Set(["hint_id", "decision", "reason", "intended_action_refs"]);
  if (
    Object.keys(input).some((key) => !allowed.has(key)) ||
    typeof input.hint_id !== "string" ||
    !input.hint_id.trim() ||
    !MEMORY_DECISIONS.some((decision) => decision === input.decision) ||
    (input.reason !== undefined && typeof input.reason !== "string") ||
    (input.intended_action_refs !== undefined &&
      (!Array.isArray(input.intended_action_refs) ||
        input.intended_action_refs.some((ref) => typeof ref !== "string" || !ref.trim())))
  )
    throw new Error("invalid memory disposition");
  return {
    hint_id: input.hint_id,
    decision: input.decision as MemoryDecision,
    reason: (input.reason as string | undefined) ?? "",
    ...(input.intended_action_refs === undefined
      ? {}
      : { intended_action_refs: input.intended_action_refs as string[] }),
  };
}

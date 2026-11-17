export const AGENT_SESSION_REJECTION_CAPABILITY = "agent-session-rejection:v1" as const;

export const AGENT_SESSION_REJECTION_CODES = {
  superseded: 1409,
  session_mismatch: 1403,
  scope_unauthorized: 1404,
} as const;

export type AgentSessionRejectionCategory = keyof typeof AGENT_SESSION_REJECTION_CODES;

export function agentSessionRejection(
  category: AgentSessionRejectionCategory,
  message: string,
  categorized: boolean,
) {
  return {
    code: categorized
      ? AGENT_SESSION_REJECTION_CODES[category]
      : category === "superseded"
        ? 409
        : 403,
    message,
    category,
  };
}

export function decodeAgentSessionRejection(error: unknown): unknown {
  if (!error || typeof error !== "object") return error;
  const value = error as { code?: unknown; message?: unknown };
  const category = (
    Object.keys(AGENT_SESSION_REJECTION_CODES) as AgentSessionRejectionCategory[]
  ).find((key) => AGENT_SESSION_REJECTION_CODES[key] === value.code);
  if (!category) return error;
  return agentSessionRejection(
    category,
    typeof value.message === "string" ? value.message : "",
    false,
  );
}

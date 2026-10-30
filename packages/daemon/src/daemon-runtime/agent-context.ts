import { AgentPreflightError } from "./agent-preflight-error";

/** The Agent a context token belongs to; an unknown or superseded token is a protocol refusal. */
export function agentIdForContext(agentContexts: Map<string, string>, context: string): string {
  const agentId = [...agentContexts.entries()].find(([, value]) => value === context)?.[0];
  if (!agentId)
    throw new AgentPreflightError("invalid agent local context", "AGENT_CONTEXT_INVALID");
  return agentId;
}

/** A fresh context token for the Agent, replacing any older one. */
export function contextFor(agentContexts: Map<string, string>, agentId: string): string {
  const context = crypto.randomUUID();
  agentContexts.set(agentId, context);
  return context;
}

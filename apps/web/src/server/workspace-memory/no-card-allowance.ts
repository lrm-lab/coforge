/**
 * Minimal fallback for the "an explicit @memory question must be answered with memory_offer" rule.
 * A cited Offer needs a citable card. When the Memory Agent's own retrieval just came back empty (empty
 * library or no hit) there is nothing to cite, so ONE plain channel message saying "no applicable card"
 * is allowed. The allowance is per Memory Agent, expires, and is cleared by the first message it covers,
 * by a later retrieval that does return items, or by a published Offer — the normal flow resumes after that.
 * Process-local on purpose: the web server that serves the retrieval also serves the send.
 */
const ALLOWANCE_TTL_MS = 10 * 60_000;
const allowances = new Map<string, number>();

const key = (workspaceId: string, agentId: string) => `${workspaceId}:${agentId}`;

export function recordMemoryRetrieval(
  workspaceId: string,
  agentId: string,
  itemCount: number,
  now = Date.now(),
): void {
  if (itemCount === 0) allowances.set(key(workspaceId, agentId), now);
  else allowances.delete(key(workspaceId, agentId));
}

export function hasNoCardAllowance(
  workspaceId: string,
  agentId: string,
  now = Date.now(),
): boolean {
  const at = allowances.get(key(workspaceId, agentId));
  if (at === undefined) return false;
  if (now - at > ALLOWANCE_TTL_MS) {
    allowances.delete(key(workspaceId, agentId));
    return false;
  }
  return true;
}

export function clearNoCardAllowance(workspaceId: string, agentId: string): void {
  allowances.delete(key(workspaceId, agentId));
}

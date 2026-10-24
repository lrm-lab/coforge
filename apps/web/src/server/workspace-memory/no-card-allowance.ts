/**
 * Minimal fallback for the "an explicit @memory question must be answered with memory_offer" rule.
 * A cited Offer needs a citable card. When the Memory Agent's own retrieval just came back empty (empty
 * library or no hit) there is nothing to cite, so ONE plain channel message saying "no applicable card"
 * is allowed. The allowance is per Memory Agent, expires, and is cleared by the first message it covers,
 * by a later retrieval that does return items, or by a published Offer — the normal flow resumes after that.
 * Retrieval that returned items but none fits is the same situation, only the server cannot tell: the first plain
 * message is refused (the Memory Agent is pushed to cite), a second one after that refusal is let through.
 * Process-local on purpose: the web server that serves the retrieval also serves the send.
 */
const ALLOWANCE_TTL_MS = 10 * 60_000;
const allowances = new Map<string, number>();
/** Per Memory Agent: when its latest retrieval returned items, and how many plain messages were refused since. */
const hits = new Map<string, { at: number; refused: number }>();

const key = (workspaceId: string, agentId: string) =>
  `${workspaceId}:${agentId}`;

export function recordMemoryRetrieval(
  workspaceId: string,
  agentId: string,
  itemCount: number,
  now = Date.now(),
): void {
  if (itemCount === 0) {
    allowances.set(key(workspaceId, agentId), now);
    hits.delete(key(workspaceId, agentId));
  } else {
    allowances.delete(key(workspaceId, agentId));
    hits.set(key(workspaceId, agentId), { at: now, refused: 0 });
  }
}

/**
 * A plain message is about to be refused because an Offer is required. When the latest retrieval returned items and
 * this is not the first refusal since, nothing the Memory Agent retrieved applies: let this one through.
 */
export function refusalBecomesNoCardAllowance(
  workspaceId: string,
  agentId: string,
  now = Date.now(),
): boolean {
  const entry = hits.get(key(workspaceId, agentId));
  if (entry === undefined || now - entry.at > ALLOWANCE_TTL_MS) return false;
  if (entry.refused === 0) {
    entry.refused = 1;
    return false;
  }
  hits.delete(key(workspaceId, agentId));
  return true;
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

export function clearNoCardAllowance(
  workspaceId: string,
  agentId: string,
): void {
  allowances.delete(key(workspaceId, agentId));
  hits.delete(key(workspaceId, agentId));
}

/**
 * Where a task-write freshness hold was offered, per Agent and target. `--anyway` on a task write
 * is honored only right after such an offer, so the review cannot be skipped preemptively. In
 * memory only: a daemon restart clears it and the next write is held (and offered) again.
 */
const OFFER_TTL_MS = 10 * 60_000;
const offered = new Map<string, number>();

const key = (agentId: string, target: string) => `${agentId}\u0000${target}`;

/** A task-write freshness hold was offered for this Agent and target: `--anyway` may confirm it. */
export function recordTaskHoldOffered(agentId: string, target: string): void {
  offered.set(key(agentId, target), Date.now());
}

/** Whether a task-write freshness hold was recently offered for this Agent and target. */
export function taskHoldOffered(agentId: string, target: string): boolean {
  const offeredAt = offered.get(key(agentId, target));
  return offeredAt !== undefined && Date.now() - offeredAt < OFFER_TTL_MS;
}

import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";

/**
 * Whether a pending mention's target can still become a channel member: a human still in the
 * Workspace, or an Agent that is public and not deleted.
 */
export function canJoinChannel(row: {
  targetAgent: { visibility: string; deletedAt: Date | null } | null;
  /** The target human's memberships of the mention's own Workspace. */
  targetUser: { memberships: readonly unknown[] } | null;
}): boolean {
  if (row.targetAgent)
    return row.targetAgent.visibility === AGENT_VISIBILITY.PUBLIC && !row.targetAgent.deletedAt;
  return Boolean(row.targetUser?.memberships.length);
}

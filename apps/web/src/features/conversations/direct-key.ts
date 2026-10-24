/**
 * A direct conversation's `directKey`: its participants' `<kind>:<id>` parts in lexical order,
 * joined by `|` (`docs/database-schema/conversations.md`). Between people both parts are
 * `user:`, and a member's conversation with themself repeats their own part.
 */
export function peopleDirectKey(userId: string, otherUserId: string) {
  return [userId, otherUserId]
    .sort()
    .map((id) => `user:${id}`)
    .join("|");
}

/** The member on the other side of a DM between people, from the viewer's seat (the viewer in their
 * conversation with themself); `undefined` for any other key. */
export function peopleDirectPeerId(directKey: string | null, viewerId: string) {
  if (!directKey || !isPeopleDirectKey(directKey)) return undefined;
  const [first, second] = peopleDirectKeyPair(directKey);
  return first === viewerId ? second : first;
}

/** The key of a member's direct conversation with an Agent (`agent:` sorts before `user:`). */
export function agentDirectKey(userId: string, agentId: string) {
  return `agent:${agentId}|user:${userId}`;
}

/** Whether a direct conversation is between people (no Agent part). */
export function isPeopleDirectKey(directKey: string) {
  return directKey.split("|").every((part) => part.startsWith("user:"));
}

/** The two people a key between people names, in key order (the same one twice for a member's
 * conversation with themself). */
export function peopleDirectKeyPair(directKey: string): [string, string] {
  const [first, second] = directKey.split("|").map((part) => part.slice("user:".length));
  return [first!, second ?? first!];
}

/** The key of two Agents' direct conversation (`agent:` parts in lexical order, as for any key). */
export function agentPeerDirectKey(agentId: string, otherAgentId: string) {
  return [agentId, otherAgentId]
    .sort()
    .map((id) => `agent:${id}`)
    .join("|");
}

/** A `directKey` filter for every Agent-to-Agent conversation (see `agentPeerDirectKey`). */
export const AGENT_PEER_DIRECT_KEY_WHERE = { startsWith: "agent:", contains: "|agent:" } as const;

/** Whether a direct conversation is between two Agents (no person is a member). */
export function isAgentPeerDirectKey(directKey: string) {
  const parts = directKey.split("|");
  return parts.length === 2 && parts.every((part) => part.startsWith("agent:"));
}

/** The Agent on the other side of an Agent-to-Agent key from `agentId`'s seat; `undefined` for any
 * other key or an Agent that is not part of it. */
export function agentPeerOf(directKey: string | null, agentId: string) {
  if (!directKey || !isAgentPeerDirectKey(directKey)) return undefined;
  const ids = directKey.split("|").map((part) => part.slice("agent:".length));
  return ids.includes(agentId) ? ids.find((id) => id !== agentId) : undefined;
}

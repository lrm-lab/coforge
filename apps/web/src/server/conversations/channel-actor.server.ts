/** A channel actor is either a human (by Workspace `userId`) or an Agent (by `agentId`); the
 * human/Web UI and the Agent CLI share `PublicChannels.members`/`addMembers` through this. */
export type ChannelActor = { userId: string } | { agentId: string };

/** A `ConversationMember` `where` clause identifying `actor`'s own row in a channel. Shared by
 * `PublicChannels` (which otherwise duplicated this as a private method) and the channel
 * modules. */
export function channelActorMemberWhere(actor: ChannelActor) {
  return "userId" in actor ? { userId: actor.userId } : { agentId: actor.agentId };
}

/** The actor a member row stands for: its person, or else its Agent. */
export function channelActorOf(member: {
  userId: string | null;
  agentId: string | null;
}): ChannelActor {
  return member.userId ? { userId: member.userId } : { agentId: member.agentId! };
}

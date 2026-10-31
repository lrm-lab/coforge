import type { PrismaClient } from "#src/generated/prisma/client";
import { CHANNEL_VISIBILITY } from "#src/features/conversations/channel-visibility";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import { errorType } from "#src/server/errors/error-type.server";
import { canSeeAgent } from "./agent-visibility.server";

/** How long an answer stands, from when it was read: a hit never renews it, so a lost
 * `channelPeopleChanged` broadcast leaves a channel's people stale for this long at most, however
 * busy the channel. */
const AUDIENCE_TTL_MS = 30_000;
const AUDIENCE_CACHE_MAX_ENTRIES = 1024;

/** What `canSeeAgent` reads of the Agent. */
export type AudienceAgent = { visibility: string; ownerId: string; systemKind: string | null };

/** A channel's visibility and, when private, its active people. */
export type ChannelPeople = { private: false } | { private: true; userIds: readonly string[] };

/** The reads behind a live Activity audience. */
export type ActivityAudienceReads = {
  /** The channel whose rule decides who reads the conversation: the channel itself, or the
   * board of a Task's own conversation; `null` for any other (a DM), `undefined` when there is
   * no such conversation. */
  governingChannel(workspaceId: string, conversationId: string): Promise<string | null | undefined>;
  channelPeople(channelId: string): Promise<ChannelPeople>;
  /** Those of `userIds` who are Workspace members and can see the Agent. */
  seeingAgent(
    workspaceId: string,
    userIds: readonly string[],
    agent: AudienceAgent,
  ): Promise<readonly string[]>;
};

/** The reads against the database `database` answers when asked (none: each read fails, and the
 * audience names nobody). */
export function prismaActivityAudienceReads(
  database: () => PrismaClient | undefined,
): ActivityAudienceReads {
  const channelSelect = { id: true, channelName: true } as const;
  const db = () => {
    const client = database();
    if (!client) throw new Error("database unavailable");
    return client;
  };
  return {
    governingChannel: async (workspaceId, conversationId) => {
      const conversation = await db().conversation.findFirst({
        where: { id: conversationId, workspaceId },
        select: {
          ...channelSelect,
          taskDiscussionOf: { select: { conversation: { select: channelSelect } } },
        },
      });
      if (!conversation) return undefined;
      const channel =
        conversation.channelName === null
          ? conversation.taskDiscussionOf?.conversation
          : conversation;
      return channel?.channelName ? channel.id : null;
    },
    channelPeople: async (channelId) => {
      const channel = await db().conversation.findUnique({
        where: { id: channelId },
        select: {
          visibility: true,
          members: {
            where: { userId: { not: null }, ...ACTIVE_MEMBER_WHERE },
            select: { userId: true },
          },
        },
      });
      if (channel?.visibility !== CHANNEL_VISIBILITY.PRIVATE) return { private: false };
      const userIds = channel.members.flatMap((member) => (member.userId ? [member.userId] : []));
      return { private: true, userIds };
    },
    seeingAgent: async (workspaceId, userIds, agent) => {
      const people = await db().workspaceMembership.findMany({
        where: { workspaceId, userId: { in: [...userIds] } },
        select: { userId: true, role: true },
      });
      return people
        .filter((person) =>
          canSeeAgent({ kind: "user", userId: person.userId, role: person.role }, agent),
        )
        .map((person) => person.userId);
    },
  };
}

/** Whether every member of the Workspace sees the Agent: what `canSeeAgent` answers a plain
 * member who did not create it. */
const seenByEveryMember = (agent: AudienceAgent) =>
  canSeeAgent({ kind: "user", userId: "", role: "member" }, agent);

/**
 * Who sees an Agent's Activity in one conversation live (task #302). For a private channel, or the
 * Task conversation of a private channel's Task, it is the channel's active people who can see the
 * Agent, each on their own channel (`userConversationChannel`), as a private channel's other
 * changes go (`channelAudience`); for any other conversation `undefined`, and the Agent's Activity
 * channel carries it as before. A read that fails names nobody, so the Activity reaches no one
 * live rather than everyone.
 *
 * Every frame of an Agent's stream asks, so the answers are remembered, process-local and
 * bounded: which channel governs a conversation of a Workspace never changes; a channel's
 * visibility and people are dropped at once by `channelPeopleChanged`, here and on every other
 * instance, with the TTL (never renewed by a hit) as the backstop. A public channel's frame, or a private one's of an Agent every member
 * sees, then costs no query; only an Agent not every member sees reads its people's roles.
 */
export function cachedActivityAudience(
  reads: ActivityAudienceReads,
  {
    ttlMs = AUDIENCE_TTL_MS,
    maxEntries = AUDIENCE_CACHE_MAX_ENTRIES,
    now = Date.now,
  }: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
) {
  const governing = new Map<string, { channelId: string | null; at: number }>();
  const people = new Map<string, { value: ChannelPeople; at: number }>();
  // A read issued before a `forget` can resolve after it: generations keep that stale answer out.
  const generations = new Map<string, number>();
  let flushEpoch = 0;
  const generation = (channelId: string) => generations.get(channelId) ?? 0;
  const fresh = <Entry extends { at: number }>(map: Map<string, Entry>, key: string) => {
    const entry = map.get(key);
    return entry && now() - entry.at < ttlMs ? entry : undefined;
  };
  const remember = <Entry>(map: Map<string, Entry>, key: string, entry: Entry) => {
    map.delete(key);
    while (map.size >= maxEntries) map.delete(map.keys().next().value!);
    map.set(key, entry);
  };

  const channelOf = async (workspaceId: string, conversationId: string) => {
    // Keyed by the Workspace too: a frame naming another Workspace's conversation finds nothing.
    const key = `${workspaceId}\u0000${conversationId}`;
    const known = fresh(governing, key);
    if (known) return known.channelId;
    const channelId = await reads.governingChannel(workspaceId, conversationId);
    // A conversation not found yet is asked again; one found always names the same channel.
    if (channelId !== undefined) remember(governing, key, { channelId, at: now() });
    return channelId;
  };
  const peopleOf = async (channelId: string) => {
    const known = fresh(people, channelId);
    if (known) return known.value;
    const epoch = flushEpoch;
    const gen = generation(channelId);
    const value = await reads.channelPeople(channelId);
    if (flushEpoch === epoch && generation(channelId) === gen)
      remember(people, channelId, { value, at: now() });
    return value;
  };

  /** Drop a channel's remembered visibility and people, or every channel's with no id. */
  const forget = (channelId?: string) => {
    // Bounded like the entries: past that, a flush stands for every remembered channel.
    if (
      channelId === undefined ||
      (generations.size >= maxEntries && !generations.has(channelId))
    ) {
      people.clear();
      generations.clear();
      flushEpoch += 1;
      return;
    }
    generations.set(channelId, generation(channelId) + 1);
    people.delete(channelId);
  };

  return {
    forget,
    async audience(
      scope: { workspaceId: string; agentId: string; conversationId: string },
      agent: () => Promise<AudienceAgent | undefined>,
    ): Promise<readonly string[] | undefined> {
      try {
        const channelId = await channelOf(scope.workspaceId, scope.conversationId);
        if (!channelId) return undefined;
        const channel = await peopleOf(channelId);
        if (!channel.private) return undefined;
        if (channel.userIds.length === 0) return [];
        const seen = await agent();
        if (!seen) return [];
        return seenByEveryMember(seen)
          ? channel.userIds
          : await reads.seeingAgent(scope.workspaceId, channel.userIds, seen);
      } catch (error) {
        console.warn(
          JSON.stringify({ event: "activity_audience:read_failed", error_type: errorType(error) }),
        );
        return [];
      }
    },
  };
}

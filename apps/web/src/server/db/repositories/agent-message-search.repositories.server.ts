import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import {
  ACTIVE_MEMBER_WHERE,
  VISIBLE_CONVERSATION_WHERE,
  TARGETABLE_CONVERSATION_WHERE,
} from "#src/server/conversations/active-member.server";
import {
  AGENT_MESSAGE_WITH_TARGET_INCLUDE,
  messageDeliveryTarget,
  toAgentMessage,
} from "./direct-conversation-agent-message.server";
import { readChannelCoordination } from "#src/server/conversations/channel-coordination.server";
import { directTargets } from "./agent-peer-direct.repositories.server";
import { clampPageLimit } from "#src/server/db/page-limit.server";
import {
  decodeAgentMessageSearchCursor,
  encodeAgentMessageSearchCursor,
} from "./agent-message-search-cursor.server";

export type AgentMessageSearchOptions = {
  query?: string;
  target?: string;
  sender?: string;
  sort?: "relevance" | "recent";
  before?: string;
  after?: string;
  limit?: number;
  offset?: number;
  /** Continues a `recent` search with a query from a previous page's `nextCursor`. */
  cursor?: string;
};

export type AgentMessageSearchPage = {
  messages: ReturnType<typeof toAgentMessage>[];
  /** Another page follows this one. */
  hasMore: boolean;
  /** Present when `hasMore` and the search is `recent` with a query: where the next page starts. */
  nextCursor?: string;
  /** The search stopped at a scan limit or timeout before covering everything it could match. */
  incomplete: boolean;
  /** With `incomplete`: how many messages were read, and the oldest time reached. */
  searchedMessages?: number;
  searchedThrough?: string;
};

export async function searchAgentMessagePage(
  db: PrismaClient,
  workspaceId: string,
  agentId: string,
  options: AgentMessageSearchOptions,
  resolveTarget: (
    target: string,
  ) => Promise<{ conversationId: string; threadRootId: string | null }>,
): Promise<AgentMessageSearchPage> {
  const limit = clampPageLimit(options.limit ?? 20, 100);
  const offset = Math.max(options.offset ?? 0, 0);
  if (options.cursor !== undefined && (!options.query || options.sort !== "recent" || offset > 0))
    throw new Error("a search cursor continues a recent search with a query and no offset");
  const scope = options.target ? await resolveTarget(options.target) : undefined;
  const before = options.before ? new Date(options.before) : undefined;
  const after = options.after ? new Date(options.after) : undefined;
  if ((before && Number.isNaN(before.getTime())) || (after && Number.isNaN(after.getTime())))
    throw new Error("search dates must be ISO datetimes");
  const sender = options.sender?.replace(/^@/, "");
  const searchQuery = options.query
    ? (
        await db.$queryRaw<Array<{ query: string }>>(
          Prisma.sql`SELECT websearch_to_tsquery(${options.query})::text AS query`,
        )
      )[0]?.query
    : undefined;
  if (options.query && !searchQuery) return { messages: [], hasMore: false, incomplete: false };
  const keyset =
    options.cursor !== undefined ? decodeAgentMessageSearchCursor(options.cursor) : undefined;
  const orderBy = (
    searchQuery && options.sort !== "recent"
      ? [
          {
            _relevance: {
              fields: ["body"],
              search: searchQuery,
              sort: "desc",
            },
          },
          { createdAt: "desc" },
          { id: "desc" },
        ]
      : [{ createdAt: "desc" }, { id: "desc" }]
  ) satisfies Prisma.MessageOrderByWithRelationInput[];
  const rows = await db.message.findMany({
    where: {
      workspaceId,
      conversation: {
        ...VISIBLE_CONVERSATION_WHERE,
        AND: [TARGETABLE_CONVERSATION_WHERE],
        members: { some: { agentId, ...ACTIVE_MEMBER_WHERE } },
        ...(scope ? { id: scope.conversationId } : {}),
      },
      ...(scope && options.target?.includes(":") ? { threadRootId: scope.threadRootId } : {}),
      ...(searchQuery ? { body: { search: searchQuery } } : {}),
      ...(sender
        ? {
            sender: {
              OR: [{ user: { username: sender } }, { agent: { name: sender } }],
            },
          }
        : {}),
      ...(keyset
        ? {
            OR: [
              { createdAt: { lt: keyset.createdAt } },
              { createdAt: keyset.createdAt, id: { lt: keyset.id } },
            ],
          }
        : {}),
      ...(before || after
        ? {
            createdAt: {
              ...(before ? { lt: before } : {}),
              ...(after ? { gt: after } : {}),
            },
          }
        : {}),
    },
    orderBy,
    skip: offset,
    take: limit + 1,
    include: AGENT_MESSAGE_WITH_TARGET_INCLUDE,
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const coordination = await readChannelCoordination(
    db,
    workspaceId,
    agentId,
    page.filter((row) => row.conversation.channelName !== null).map((row) => row.conversationId),
  );
  const targetOf = await directTargets(
    db,
    workspaceId,
    agentId,
    page.map((message) => message.conversation),
  );
  const last = page.at(-1);
  return {
    messages: page.map((message) =>
      toAgentMessage(
        message,
        messageDeliveryTarget(message, targetOf),
        agentId,
        coordination.get(message.conversationId),
      ),
    ),
    hasMore,
    nextCursor:
      hasMore && last && searchQuery && options.sort === "recent"
        ? encodeAgentMessageSearchCursor({ createdAt: last.createdAt, id: last.id })
        : undefined,
    // The query is a single indexed statement with no scan cap or timeout of its own.
    incomplete: false,
  };
}

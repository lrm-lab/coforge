import {
  AGENT_INBOX_PAGE_SIZE,
  type AgentInboxItem,
  type AgentInboxListResponse,
  type AgentInboxView,
} from "@lrm/coforge-sdk/agent";
import type { PrismaClient } from "#src/generated/prisma/client";

type UnreadRow = {
  conversationId: string;
  channelName: string | null;
  peer: string | null;
  muted: boolean;
  readSeq: number;
  unread: number;
  mentions: number;
  latestSeq: number;
  latestAt: Date;
};

/**
 * What the Agent has not read, one row per conversation, in one statement however many
 * conversations or messages there are: an index range probe per conversation
 * (`messages(conversationId, threadRootId, sequence)`) over the Agent's own active memberships.
 *
 * Our own definition of unread, not Raft's: the top-level messages other people wrote after the
 * Agent's read position (`agentReadThroughSequence`, the one `message read` advances). Thread
 * replies are followed through their threads and left out, as are the Agent's own messages, App
 * event conversations, archived channels and channels hidden from the Workspace.
 */
async function unreadConversations(
  db: Pick<PrismaClient, "$queryRaw">,
  workspaceId: string,
  agentId: string,
): Promise<UnreadRow[]> {
  return db.$queryRaw<UnreadRow[]>`
    SELECT mine."conversationId", mine."channelName", peer.handle AS peer, mine.muted,
           mine."readSeq", u.unread, u.mentions, u."latestSeq", u."latestAt"
    FROM (
      SELECT m.id AS "memberId", m."conversationId", c."channelName",
             m."channelMuted" AS muted, m."agentReadThroughSequence" AS "readSeq",
             m."joinedAt" AS "joinedAt"
      FROM "conversation_members" m
      JOIN "conversations" c ON c.id = m."conversationId" AND c."workspaceId" = m."workspaceId"
      WHERE m."workspaceId" = ${workspaceId}::uuid AND m."agentId" = ${agentId}::uuid
        AND m."leftAt" IS NULL AND c."archivedAt" IS NULL AND c."hiddenFromWorkspaceAt" IS NULL
        AND c.kind IS NULL
    ) mine
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS unread,
             (count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM "message_mentions" mm
               WHERE mm."messageId" = x.id AND mm."memberId" = mine."memberId")))::int AS mentions,
             max(x.sequence)::int AS "latestSeq", max(x."createdAt") AS "latestAt"
      FROM "messages" x
      WHERE x."conversationId" = mine."conversationId" AND x."threadRootId" IS NULL
        AND x.sequence > mine."readSeq"
        AND (mine."channelName" IS NULL OR x."createdAt" >= mine."joinedAt")
        AND x."senderMemberId" IS DISTINCT FROM mine."memberId"
    ) u
    LEFT JOIN LATERAL (
      SELECT COALESCE(usr.username, agt.name) AS handle
      FROM "conversation_members" o
      LEFT JOIN "users" usr ON usr.id = o."userId"
      LEFT JOIN "agents" agt ON agt.id = o."agentId" AND agt."workspaceId" = o."workspaceId"
      WHERE o."conversationId" = mine."conversationId" AND o.id <> mine."memberId" LIMIT 1
    ) peer ON mine."channelName" IS NULL
    WHERE u.unread > 0 AND (NOT mine.muted OR u.mentions > 0)`;
}

/**
 * The Agent's unread conversations, newest activity first, for `coforge inbox check`.
 *
 * - A muted channel appears only while it holds an unread mention: a personal @mention overrides
 *   mute, ordinary messages do not wake the Agent.
 * - `mentions` view lists the conversations with an unread mention; `totals` always cover every
 *   unread conversation, whatever the view or page.
 * - Paging is by activity time: `beforeSeq` (epoch milliseconds, copied from `nextBeforeSeq`)
 *   keeps conversations whose latest unread message is older. A page that ends inside a run of
 *   equal times is extended to the end of the run, so nothing is skipped or repeated.
 */
export async function listAgentInbox(
  db: Pick<PrismaClient, "$queryRaw">,
  workspaceId: string,
  agentId: string,
  { view = "unread", beforeSeq }: { view?: AgentInboxView; beforeSeq?: number } = {},
  pageSize = AGENT_INBOX_PAGE_SIZE,
): Promise<AgentInboxListResponse> {
  const unread = await unreadConversations(db, workspaceId, agentId);
  const totals = {
    conversations: unread.length,
    dms: unread.filter((row) => row.channelName === null).length,
    mentions: unread.filter((row) => row.mentions > 0).length,
  };
  const inView = unread
    .filter((row) => (view === "mentions" ? row.mentions > 0 : true))
    .filter((row) => beforeSeq === undefined || row.latestAt.getTime() < beforeSeq)
    .sort(
      (a, b) =>
        b.latestAt.getTime() - a.latestAt.getTime() ||
        (a.conversationId < b.conversationId ? 1 : -1),
    );
  let end = Math.min(pageSize, inView.length);
  while (
    end < inView.length &&
    inView[end]!.latestAt.getTime() === inView[end - 1]!.latestAt.getTime()
  )
    end += 1;
  const page = inView.slice(0, end);
  const senders = await latestSenders(db, page);
  const items = page.map((row): AgentInboxItem => ({
    target: row.channelName === null ? `@${row.peer ?? "unknown"}` : `#${row.channelName}`,
    unread: row.unread,
    mentions: row.mentions,
    latestAt: row.latestAt.toISOString(),
    latestSenderName: senders.get(row.conversationId) ?? null,
    lastReadSeq: row.readSeq,
  }));
  const hasMore = end < inView.length;
  return {
    ok: true,
    view,
    items,
    totals,
    hasMore,
    nextBeforeSeq: hasMore ? page[page.length - 1]!.latestAt.getTime() : null,
  };
}

/** Who wrote each page conversation's latest unread message (their username or Agent name). */
async function latestSenders(
  db: Pick<PrismaClient, "$queryRaw">,
  page: readonly UnreadRow[],
): Promise<Map<string, string>> {
  if (page.length === 0) return new Map();
  const rows = await db.$queryRaw<{ conversationId: string; sender: string | null }[]>`
    SELECT p."conversationId", COALESCE(usr.username, agt.name) AS sender
    FROM unnest(${page.map((row) => row.conversationId)}::uuid[], ${page.map((row) => row.latestSeq)}::int[])
      AS p("conversationId", seq)
    JOIN "messages" x ON x."conversationId" = p."conversationId" AND x.sequence = p.seq
    JOIN "conversation_members" s ON s.id = x."senderMemberId"
    LEFT JOIN "users" usr ON usr.id = s."userId"
    LEFT JOIN "agents" agt ON agt.id = s."agentId" AND agt."workspaceId" = s."workspaceId"`;
  return new Map(rows.flatMap((row) => (row.sender ? [[row.conversationId, row.sender]] : [])));
}

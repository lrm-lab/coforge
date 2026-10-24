import { UUID_LIKE_PATTERN } from "@lrm/coforge-sdk/internal";

import type { PrismaClient } from "#src/generated/prisma/client";
import { readChannelCoordination } from "#src/server/conversations/channel-coordination.server";
import { clampPageLimit } from "#src/server/db/page-limit.server";
import { directTargets } from "#src/server/db/repositories/agent-peer-direct.repositories.server";
import { unreadAgentMessagesFragment } from "#src/server/db/repositories/agent-attention.repositories.server";
import {
  AGENT_MESSAGE_WITH_TARGET_INCLUDE,
  messageDeliveryTarget,
  toAgentMessage,
} from "#src/server/db/repositories/direct-conversation-agent-message.server";

/** The cursor was not one `check` gave out. */
export class AppBotInboxCursorError extends Error {
  constructor() {
    super("invalid inbox cursor");
    this.name = "AppBotInboxCursorError";
  }
}

/** What a pull covered, as the next `check` hands it back to acknowledge it: the highest sequence
 * read in each conversation (or thread), and the messages read from outside a channel. */
type Cursor = {
  groups: [conversationId: string, threadRootId: string | null, sequence: number][];
  outside: string[];
};

const MAX_ENTRIES = 300;
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_LIKE_PATTERN.test(value);

function encode(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decode(value: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const { groups, outside } = parsed as Cursor;
    if (
      !Array.isArray(groups) ||
      !Array.isArray(outside) ||
      groups.length + outside.length > MAX_ENTRIES ||
      !outside.every(isUuid) ||
      !groups.every(
        (group) =>
          Array.isArray(group) &&
          group.length === 3 &&
          isUuid(group[0]) &&
          (group[1] === null || isUuid(group[1])) &&
          Number.isSafeInteger(group[2]) &&
          group[2] > 0,
      )
    )
      throw new AppBotInboxCursorError();
    return { groups, outside };
  } catch {
    throw new AppBotInboxCursorError();
  }
}

/**
 * The inbox of an app's bot: what waits for it, read without taking it. `check` returns the unread
 * messages with a `cursor`; nothing is acknowledged by reading, so a batch the app lost before
 * handling comes back. Handing the cursor back as `since` on the next `check` acknowledges
 * everything up to it (the read boundary of the Agent moves, as it does when a daemon drains), and
 * answers what has arrived since. Replaying a cursor is harmless: boundaries only move forward.
 */
export class AppBotInbox {
  constructor(private readonly db: PrismaClient) {}

  async check(
    scope: { workspaceId: string; agentId: string },
    input: { since?: string; limit?: number } = {},
  ) {
    if (input.since !== undefined) await this.acknowledge(scope, decode(input.since));
    return this.peek(scope, clampPageLimit(input.limit ?? 20, 100));
  }

  private async peek(
    { workspaceId, agentId }: { workspaceId: string; agentId: string },
    limit: number,
  ) {
    const rows = await this.db.$queryRaw<
      {
        id: string;
        conversationId: string;
        threadRootId: string | null;
        sequence: number;
        nonMemberMention: boolean;
      }[]
    >`
      WITH unread AS (
        ${unreadAgentMessagesFragment(workspaceId, agentId)}
      )
      SELECT "id", "conversationId", "threadRootId", "sequence", "nonMemberMention"
      FROM unread
      ORDER BY "conversationId", "rootSequence", "sequence"
      LIMIT ${limit + 1}`;
    const page = rows.slice(0, limit);
    const cursor: Cursor = { groups: [], outside: [] };
    if (!page.length) return { events: [], hasMore: false, cursor: encode(cursor) };
    const found = await this.db.message.findMany({
      where: { id: { in: page.map((row) => row.id) } },
      include: AGENT_MESSAGE_WITH_TARGET_INCLUDE,
    });
    const byId = new Map(found.map((message) => [message.id, message]));
    const targetOf = await directTargets(
      this.db,
      workspaceId,
      agentId,
      found.map((message) => message.conversation),
    );
    const coordination = await readChannelCoordination(
      this.db,
      workspaceId,
      agentId,
      found.filter((m) => m.conversation.channelName !== null).map((m) => m.conversationId),
    );
    const highest = new Map<string, Cursor["groups"][number]>();
    const events = page.map((row) => {
      const message = byId.get(row.id);
      if (!message) throw new Error(`inbox message is missing: ${row.id}`);
      if (row.nonMemberMention) cursor.outside.push(row.id);
      else {
        const key = `${row.conversationId}:${row.threadRootId ?? ""}`;
        const seen = highest.get(key);
        if (!seen || row.sequence > seen[2])
          highest.set(key, [row.conversationId, row.threadRootId, row.sequence]);
      }
      return {
        ...toAgentMessage(
          message,
          messageDeliveryTarget(message, targetOf),
          agentId,
          coordination.get(row.conversationId),
        ),
        // Reached the bot outside the channel: readable, but it cannot reply there.
        ...(row.nonMemberMention ? { nonMemberMention: true } : {}),
      };
    });
    cursor.groups = [...highest.values()];
    return { events, hasMore: rows.length > limit, cursor: encode(cursor) };
  }

  private async acknowledge(
    { workspaceId, agentId }: { workspaceId: string; agentId: string },
    cursor: Cursor,
  ) {
    await this.db.$transaction(async (tx) => {
      const channels = cursor.groups.filter(([, threadRootId]) => !threadRootId);
      for (const [conversationId, , sequence] of channels)
        await tx.conversationMember.updateMany({
          where: { conversationId, agentId, agentReadThroughSequence: { lt: sequence } },
          data: { agentReadThroughSequence: sequence },
        });
      const threads = cursor.groups.filter(([, threadRootId]) => threadRootId);
      if (threads.length) {
        // One lookup of the bot's memberships and one upsert for every thread; the position only
        // moves forward, atomically, across replicas.
        const members = await tx.conversationMember.findMany({
          where: {
            agentId,
            conversationId: { in: threads.map(([conversationId]) => conversationId) },
          },
          select: { id: true, conversationId: true },
        });
        const memberOf = new Map(members.map((member) => [member.conversationId, member.id]));
        const rows = threads.flatMap(([conversationId, threadRootId, sequence]) => {
          const memberId = memberOf.get(conversationId);
          return memberId
            ? [{ memberId, conversationId, threadRootId: threadRootId!, sequence }]
            : [];
        });
        if (rows.length)
          await tx.$executeRaw`INSERT INTO "thread_reads"
            ("memberId", "conversationId", "workspaceId", "rootMessageId", "readThroughSequence")
            SELECT t."memberId", t."conversationId", ${workspaceId}::uuid, t."rootMessageId", t."sequence"
            FROM unnest(
              ${rows.map((row) => row.memberId)}::uuid[],
              ${rows.map((row) => row.conversationId)}::uuid[],
              ${rows.map((row) => row.threadRootId)}::uuid[],
              ${rows.map((row) => row.sequence)}::int[]
            ) AS t("memberId", "conversationId", "rootMessageId", "sequence")
            ON CONFLICT ("memberId", "rootMessageId") DO UPDATE SET "readThroughSequence" =
              GREATEST("thread_reads"."readThroughSequence", EXCLUDED."readThroughSequence")`;
      }
      if (cursor.outside.length)
        await tx.pendingMentionAction.updateMany({
          where: {
            workspaceId,
            targetAgentId: agentId,
            messageId: { in: cursor.outside },
            notifiedAt: { not: null },
            targetReadAt: null,
          },
          data: { targetReadAt: new Date() },
        });
    });
  }
}

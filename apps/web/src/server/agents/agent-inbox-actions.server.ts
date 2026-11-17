import type {
  AgentInboxDismissRequest,
  AgentInboxDismissResponse,
  AgentInboxReadItem,
  AgentInboxReadRequest,
  AgentInboxReadResponse,
  AgentInboxReadTargetKind,
} from "@lrm/coforge-sdk/agent";
import {
  isChannelMessageTarget,
  isChannelTarget,
  MAX_MESSAGE_SEQUENCE,
  threadReferenceText,
} from "@lrm/coforge-sdk/internal";
import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  APP_EVENT_TARGET,
  appEventTarget,
  isSystemEventSource,
  systemEventTarget,
} from "#src/server/app-agent-events/app-event-target.server";
import { AgentMessageValidationError } from "#src/server/conversations/agent-message-validation-error.server";
import {
  directRefs,
  type DirectSeat,
} from "#src/server/db/repositories/agent-peer-direct.repositories.server";
import type { ConversationReadRealtimePort } from "#src/server/db/repositories/agent-read-groups.repositories.server";
import {
  advanceAgentReadPosition,
  type ConversationReadChangedInput,
} from "#src/server/db/repositories/agent-read-position.repositories.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { advanceAgentRead } from "#src/server/db/repositories/thread-read-position.server";
import {
  dismissDueAgentReminders,
  readAgentInboxReminders,
  REMINDER_TARGET_PREFIX,
} from "#src/server/reminders/agent-inbox-reminders.server";
import type { ReminderPublisher } from "#src/server/reminders/reminders.server";
import type { AgentMessageRepository } from "./agent-messages.server";

const DEFAULT_INBOX_READ_LIMIT = 20;
const MAX_INBOX_READ_LIMIT = 100;

export type AgentInboxPrincipal = {
  workspaceId: string;
  agentId: string;
  computerId?: string;
  userId?: string;
};

type CutoffMemberRow = {
  memberId: string;
  conversationId: string;
  channelName: string | null;
  directKey: string | null;
  kind: string | null;
  peer: string | null;
  peerKind: "human" | "agent" | null;
  appKey: string | null;
  maxSeq: number;
};

function classifyInboxTarget(target: string): AgentInboxReadTargetKind {
  if (target === "reminders" || target.startsWith(REMINDER_TARGET_PREFIX)) return "reminders";
  if (APP_EVENT_TARGET.test(target)) return "app_events";
  if (isChannelMessageTarget(target) && !isChannelTarget(target)) return "thread";
  return "conversation";
}

function formatSender(
  raw: {
    senderName?: string | null;
    senderHandle?: string | null;
    sender?: string | null;
  },
  fallbackTarget: string,
): string {
  const candidate = raw.senderHandle ?? raw.senderName ?? raw.sender;
  if (!candidate) return fallbackTarget.startsWith("@app.") ? fallbackTarget : "system";
  return candidate.startsWith("@") ? candidate : `@${candidate}`;
}

export async function readAgentInboxTarget(
  db: PrismaClient,
  principal: AgentInboxPrincipal,
  input: AgentInboxReadRequest,
  dependencies: {
    messageReader?: Pick<AgentMessageRepository, "readMessagesPage">;
    realtime?: ConversationReadRealtimePort;
  } = {},
): Promise<AgentInboxReadResponse> {
  const target = input.target.trim();
  const limit = Math.min(
    MAX_INBOX_READ_LIMIT,
    Math.max(1, input.limit ?? DEFAULT_INBOX_READ_LIMIT),
  );
  const kind = classifyInboxTarget(target);

  if (kind === "reminders") {
    return readAgentInboxReminders(db, principal, {
      target,
      limit,
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    });
  }

  const reader =
    dependencies.messageReader ??
    new PrismaDirectConversationRepository(
      db,
      { oneRequest: true },
      dependencies.realtime as never,
    );
  if (!reader.readMessagesPage) throw new Error("Agent message read is unavailable");
  let after = input.cursor;
  let page = await reader.readMessagesPage(principal.workspaceId, principal.agentId, target, {
    unread: true,
    ...(after ? { after } : {}),
    limit,
  });
  for (
    let step = 0;
    step < 3 &&
    page.messages.length === 0 &&
    Boolean(page.moreUnread || page.hasNewer) &&
    (page.readPositionAfter ?? page.modelSeenUpToSeq) !== undefined &&
    String(page.readPositionAfter ?? page.modelSeenUpToSeq) !== after;
    step += 1
  ) {
    after = String(page.readPositionAfter ?? page.modelSeenUpToSeq);
    page = await reader.readMessagesPage(principal.workspaceId, principal.agentId, target, {
      unread: true,
      after,
      limit,
    });
  }
  const items: AgentInboxReadItem[] = page.messages.map((message) => {
    const raw = message as unknown as {
      id: string;
      sequence: number;
      senderName?: string | null;
      senderHandle?: string | null;
      sender?: string | null;
      createdAt: Date | string;
      body: string;
      mentionsAgent?: boolean;
    };
    return {
      kind: "message",
      id: raw.id,
      seq: raw.sequence,
      sender: formatSender(raw, target),
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : raw.createdAt.toISOString(),
      body: raw.body,
      ...(raw.mentionsAgent ? { mentionsAgent: true } : {}),
    };
  });
  const hasMore = Boolean(page.moreUnread || page.hasNewer);
  const scannedSeq =
    page.readPositionAfter ??
    page.modelSeenUpToSeq ??
    (items.length > 0 && items[items.length - 1]!.kind === "message"
      ? (items[items.length - 1] as Extract<AgentInboxReadItem, { kind: "message" }>).seq
      : undefined);
  return {
    ok: true,
    kind,
    target,
    items,
    hasMore,
    nextCursor: hasMore && scannedSeq !== undefined ? String(scannedSeq) : null,
    ...(page.readPositionAfter !== undefined ? { readPositionAfter: page.readPositionAfter } : {}),
  };
}

async function formatCutoffTargets(
  db: PrismaClient,
  principal: AgentInboxPrincipal,
  rows: readonly CutoffMemberRow[],
): Promise<string[]> {
  const seats: DirectSeat[] = rows.flatMap((row) =>
    row.channelName === null && row.kind === null && row.peer && row.peerKind
      ? [{ name: row.peer, kind: row.peerKind }]
      : [],
  );
  const refOf = seats.length
    ? await directRefs(db, principal.workspaceId, principal.agentId, seats)
    : undefined;
  return rows.map((row) => {
    if (row.channelName !== null) return `#${row.channelName}`;
    if (row.kind === "app_events") {
      if (row.appKey) return appEventTarget(row.appKey);
      if (row.directKey?.startsWith("system:")) {
        const sys = row.directKey.split("|")[0]!.slice("system:".length);
        if (isSystemEventSource(sys)) return systemEventTarget(sys);
      }
      return "@app";
    }
    if (row.peer && row.peerKind && refOf) {
      return refOf({ name: row.peer, kind: row.peerKind });
    }
    return "@dm";
  });
}

async function advanceResolvedTargetWithRealtime(
  db: PrismaClient,
  principal: AgentInboxPrincipal,
  target: string,
  realtime?: ConversationReadRealtimePort,
): Promise<number> {
  const repo = new PrismaDirectConversationRepository(db, { oneRequest: true }, realtime as never);
  const resolved = await repo.resolveAgentTarget(principal.workspaceId, principal.agentId, target);
  const [latest, member, conv] = await Promise.all([
    db.message.findFirst({
      where: { conversationId: resolved.conversationId, threadRootId: resolved.threadRootId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    }),
    db.conversationMember.findUniqueOrThrow({
      where: {
        conversationId_agentId: {
          conversationId: resolved.conversationId,
          agentId: principal.agentId,
        },
      },
      select: { id: true },
    }),
    db.conversation.findUnique({
      where: { id: resolved.conversationId },
      select: { kind: true },
    }),
  ]);
  const bounded = Math.min(MAX_MESSAGE_SEQUENCE, latest?.sequence ?? 0);
  if (!bounded) return 0;
  const change = await db.$transaction((tx) =>
    advanceAgentReadPosition({
      db: tx,
      memberId: member.id,
      conversationId: resolved.conversationId,
      workspaceId: principal.workspaceId,
      agentId: principal.agentId,
      threadRootId: resolved.threadRootId,
      sequence: bounded,
      publishConversationRead: conv?.kind === null,
    }),
  );
  if (change && realtime?.conversationReadChanged) {
    await realtime.conversationReadChanged(change).catch(() => undefined);
  }
  return bounded;
}

export async function dismissAgentInbox(
  db: PrismaClient,
  principal: AgentInboxPrincipal,
  input: AgentInboxDismissRequest,
  dependencies: {
    advanceTarget?: (target: string) => Promise<number>;
    dismissReminder?: (reminderId: string, computerId: string, version: number) => Promise<void>;
    realtime?: ConversationReadRealtimePort;
    publishReminderSync?: ReminderPublisher;
  } = {},
): Promise<AgentInboxDismissResponse> {
  if (input.target !== undefined) {
    const target = input.target.trim();
    const kind = classifyInboxTarget(target);
    if (kind === "reminders") {
      const specificId = target.startsWith(REMINDER_TARGET_PREFIX)
        ? target.slice(REMINDER_TARGET_PREFIX.length).trim()
        : undefined;
      const dismissedTargets = await dismissDueAgentReminders(db, principal, {
        ...(specificId !== undefined ? { specificId } : {}),
        dueBefore: new Date(),
        ...(dependencies.dismissReminder ? { customDismiss: dependencies.dismissReminder } : {}),
        ...(dependencies.publishReminderSync
          ? { publishReminderSync: dependencies.publishReminderSync }
          : {}),
      });
      return {
        ok: true,
        mode: "target",
        dismissedConversations: 0,
        dismissedThreads: 0,
        dismissedAppTargets: 0,
        dismissedReminders: dismissedTargets.length,
        targets: dismissedTargets,
      };
    }

    const advance =
      dependencies.advanceTarget ??
      ((t: string) => advanceResolvedTargetWithRealtime(db, principal, t, dependencies.realtime));
    try {
      await advance(target);
    } catch (error) {
      if (error instanceof AgentMessageValidationError)
        throw new AppError("INVALID_INPUT", { hint: error.message });
      throw error;
    }
    return {
      ok: true,
      mode: "target",
      dismissedConversations: kind === "conversation" ? 1 : 0,
      dismissedThreads: kind === "thread" ? 1 : 0,
      dismissedAppTargets: kind === "app_events" ? 1 : 0,
      dismissedReminders: 0,
      targets: [target],
    };
  }

  const cutoff = new Date(input.before!);
  if (Number.isNaN(cutoff.getTime()))
    throw new AppError("INVALID_INPUT", { hint: "before must be a valid ISO-8601 timestamp" });

  const candidateMembers = await db.$queryRaw<CutoffMemberRow[]>(
    Prisma.sql`
      SELECT m.id AS "memberId",
             c.id AS "conversationId",
             c."channelName",
             c."directKey",
             c.kind,
             peer.handle AS peer,
             peer.kind AS "peerKind",
             app.key AS "appKey",
             MAX(x.sequence)::int AS "maxSeq"
      FROM "conversation_members" m
      JOIN "conversations" c ON c.id = m."conversationId" AND c."workspaceId" = m."workspaceId"
      JOIN "messages" x ON x."conversationId" = m."conversationId"
        AND x."threadRootId" IS NULL
        AND x.sequence > m."agentReadThroughSequence"
        AND x."createdAt" < ${cutoff}
      LEFT JOIN LATERAL (
        SELECT COALESCE(usr.username, agt.name) AS handle,
               CASE WHEN usr.id IS NOT NULL THEN 'human' ELSE 'agent' END AS kind
        FROM "conversation_members" o
        LEFT JOIN "users" usr ON usr.id = o."userId"
        LEFT JOIN "agents" agt ON agt.id = o."agentId" AND agt."workspaceId" = o."workspaceId"
        WHERE o."conversationId" = m."conversationId" AND o.id <> m.id
        LIMIT 1
      ) peer ON c."directKey" IS NOT NULL AND c.kind IS NULL
      LEFT JOIN "apps" app
        ON c.kind = 'app_events'
       AND c."directKey" LIKE 'app:%'
       AND app.id::text = split_part(split_part(c."directKey", '|', 1), ':', 2)
      WHERE m."workspaceId" = ${principal.workspaceId}::uuid
        AND m."agentId" = ${principal.agentId}::uuid
        AND m."leftAt" IS NULL
        AND c."archivedAt" IS NULL
        AND c."hiddenFromWorkspaceAt" IS NULL
        AND (c.kind IS NULL OR c.kind = 'app_events')
      GROUP BY m.id, c.id, c."channelName", c."directKey", c.kind, peer.handle, peer.kind, app.key`,
  );

  const advancedRows: CutoffMemberRow[] = [];
  const readChanges: ConversationReadChangedInput[] = [];
  if (candidateMembers.length > 0) {
    await db.$transaction(async (tx) => {
      for (const row of candidateMembers) {
        const didAdvance = await advanceAgentRead(tx, {
          memberId: row.memberId,
          conversationId: row.conversationId,
          workspaceId: principal.workspaceId,
          agentId: principal.agentId,
          threadRootId: null,
          sequence: row.maxSeq,
        });
        if (!didAdvance) continue;
        advancedRows.push(row);
        if (row.kind === null) {
          readChanges.push({
            workspaceId: principal.workspaceId,
            conversationId: row.conversationId,
            memberId: row.memberId,
            readThroughSequence: row.maxSeq,
          });
        }
      }
    });
    const publishRead = dependencies.realtime?.conversationReadChanged?.bind(dependencies.realtime);
    if (publishRead) {
      await Promise.all(readChanges.map((change) => publishRead(change).catch(() => undefined)));
    }
  }

  const formattedMemberTargets =
    advancedRows.length > 0 ? await formatCutoffTargets(db, principal, advancedRows) : [];

  const advancedThreads = await db.$queryRaw<Array<{ channelName: string; rootMessageId: string }>>(
    Prisma.sql`
      WITH thread_cutoff AS (
        SELECT tf."memberId",
               tf."conversationId",
               tf."workspaceId",
               tf."rootMessageId",
               c."channelName",
               MAX(x.sequence)::int AS "maxSeq"
        FROM "thread_follows" tf
        JOIN "conversation_members" m ON m.id = tf."memberId" AND m."leftAt" IS NULL
        JOIN "conversations" c ON c.id = tf."conversationId" AND c."workspaceId" = tf."workspaceId"
        LEFT JOIN "thread_reads" tr
          ON tr."memberId" = tf."memberId" AND tr."rootMessageId" = tf."rootMessageId"
        JOIN "messages" x ON x."conversationId" = tf."conversationId"
          AND x."threadRootId" = tf."rootMessageId"
          AND x.sequence > COALESCE(tr."readThroughSequence", 0)
          AND x."createdAt" < ${cutoff}
        WHERE m."workspaceId" = ${principal.workspaceId}::uuid
          AND m."agentId" = ${principal.agentId}::uuid
          AND tf."unfollowedAt" IS NULL
          AND c."channelName" IS NOT NULL
          AND c.kind IS NULL
        GROUP BY tf."memberId", tf."conversationId", tf."workspaceId", tf."rootMessageId", c."channelName"
      ),
      upserted AS (
        INSERT INTO "thread_reads" ("memberId", "conversationId", "workspaceId", "rootMessageId", "readThroughSequence")
        SELECT "memberId", "conversationId", "workspaceId", "rootMessageId", "maxSeq"
        FROM thread_cutoff
        ON CONFLICT ("memberId", "rootMessageId") DO UPDATE
          SET "readThroughSequence" = EXCLUDED."readThroughSequence"
          WHERE EXCLUDED."readThroughSequence" > "thread_reads"."readThroughSequence"
        RETURNING "conversationId", "rootMessageId"
      )
      SELECT tc."channelName", u."rootMessageId"::text AS "rootMessageId"
      FROM upserted u
      JOIN thread_cutoff tc ON tc."rootMessageId" = u."rootMessageId" AND tc."conversationId" = u."conversationId"`,
  );

  const reminderTargets = await dismissDueAgentReminders(db, principal, {
    dueBefore: cutoff,
    beforeExclusive: true,
    ...(dependencies.dismissReminder ? { customDismiss: dependencies.dismissReminder } : {}),
    ...(dependencies.publishReminderSync
      ? { publishReminderSync: dependencies.publishReminderSync }
      : {}),
  });

  let dismissedConversations = 0;
  let dismissedAppTargets = 0;
  for (const row of advancedRows) {
    if (row.kind === "app_events") dismissedAppTargets += 1;
    else dismissedConversations += 1;
  }

  return {
    ok: true,
    mode: "before",
    dismissedConversations,
    dismissedThreads: advancedThreads.length,
    dismissedAppTargets,
    dismissedReminders: reminderTargets.length,
    targets: [
      ...formattedMemberTargets,
      ...advancedThreads.map((row) =>
        threadReferenceText(`#${row.channelName}`, row.rootMessageId),
      ),
      ...reminderTargets,
    ],
  };
}

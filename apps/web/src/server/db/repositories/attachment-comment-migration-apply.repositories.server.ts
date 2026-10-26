import { Prisma } from "#src/generated/prisma/client";
import type {
  AttachmentCommentMigrationPlan,
  AttachmentCommentMigrationSnapshot,
} from "#src/server/attachments/attachment-comment-migration.server";
import type {
  AttachmentCommentMigrationJournal,
  CommentMigrationBackup,
  CommentMigrationScope,
  MigrationRow,
} from "#src/server/attachments/attachment-comment-migration-journal.server";
import {
  deferCommentMigrationKeys,
  finishCommentMigrationKeys,
  dropLegacyCommentMetadataKey,
  addOrdinaryCommentMetadataKey,
} from "./attachment-comment-migration-constraints.repositories.server";
import {
  migrationIds,
  migrationRelation,
  migrationText,
  migrationNullableText,
  migrationFingerprint,
} from "./attachment-comment-migration-journal.repositories.server";

/** Raw storage work only: the caller supplies the domain's complete, ready plan. */
export async function applyCommentMigrationToCopy(
  tx: Prisma.TransactionClient,
  scope: CommentMigrationScope,
  snapshot: AttachmentCommentMigrationSnapshot,
  plan: AttachmentCommentMigrationPlan,
  before: CommentMigrationBackup,
) {
  await deferCommentMigrationKeys(tx, scope, before);
  await dropLegacyCommentMetadataKey(tx, scope, before);
  const resolvedMembers: AttachmentCommentMigrationJournal["resolvedMembers"] = [];
  const createdMemberIds: string[] = [];
  const created = new Map<string, string>();
  for (const mapping of plan.memberMappings) {
    let targetMemberId = mapping.targetMemberId;
    if (!targetMemberId) {
      const key = `${mapping.conversationId}:${mapping.userId ?? mapping.agentId}`;
      targetMemberId = created.get(key) ?? null;
      if (!targetMemberId) {
        const thread = snapshot.threads.find(
          (row) => row.sourceConversationId === mapping.conversationId,
        )!;
        const member = await tx.conversationMember.create({
          data: {
            conversationId: mapping.conversationId,
            workspaceId: thread.workspaceId,
            userId: mapping.userId,
            agentId: mapping.agentId,
            leftAt: new Date(),
          },
        });
        targetMemberId = member.id;
        created.set(key, member.id);
        createdMemberIds.push(member.id);
      }
    }
    resolvedMembers.push({ fromMemberId: mapping.fromMemberId, targetMemberId });
  }
  for (const table of [
    "thread_reads",
    "thread_follows",
    "workspace_assistant_read_cursors",
  ] as const) {
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM ${migrationRelation(scope.schema, table)} WHERE ${migrationIds(Prisma.sql`"conversationId"`, scope.oldConversationIds)}`,
    );
  }
  // All roots first: otherwise ON UPDATE CASCADE moves replies with colliding old sequences.
  await tx.$executeRaw(
    Prisma.sql`UPDATE ${migrationRelation(scope.schema, "messages")} SET "threadRootId" = NULL WHERE ${migrationIds(Prisma.sql`id`, scope.messageIds)}`,
  );
  const members = new Map(resolvedMembers.map((row) => [row.fromMemberId, row.targetMemberId]));
  for (const move of plan.moves) {
    const old = before.messages.find((row) => row.id === move.messageId)!;
    const sender = members.get(migrationText(old, "senderMemberId"));
    if (!sender) throw new Error("Missing historical sender mapping");
    const changed =
      await tx.$executeRaw(Prisma.sql`UPDATE ${migrationRelation(scope.schema, "messages")}
      SET "conversationId" = ${move.conversationId}::uuid, sequence = ${move.sequence},
        "senderMemberId" = ${sender}::uuid, "threadRootId" = ${move.threadRootId}::uuid
      WHERE id = ${move.messageId}::uuid`);
    if (changed !== 1) throw new Error("Migration message changed");
  }
  for (const [table, rows] of [
    ["message_reactions", before.reactions],
    ["message_mentions", before.mentions],
    ["saved_messages", before.saved],
  ] as const) {
    for (const row of rows.filter((entry) =>
      scope.messageIds.includes(migrationText(entry, "messageId")),
    )) {
      const target = members.get(migrationText(row, "memberId"));
      if (!target) throw new Error("Missing historical reference actor mapping");
      const emoji =
        table === "message_reactions"
          ? Prisma.sql`AND emoji = ${migrationText(row, "emoji")}`
          : Prisma.empty;
      const changed =
        await tx.$executeRaw(Prisma.sql`UPDATE ${migrationRelation(scope.schema, table)} SET "memberId" = ${target}::uuid
        WHERE "messageId" = ${migrationText(row, "messageId")}::uuid AND "memberId" = ${migrationText(row, "memberId")}::uuid ${emoji}`);
      if (changed !== 1) throw new Error("Historical reference collision");
    }
  }
  for (const cursor of plan.threadReadMappings) {
    const workspaceId = snapshot.threads.find(
      (row) => row.sourceConversationId === cursor.conversationId,
    )!.workspaceId;
    await tx.threadRead.upsert({
      where: {
        memberId_rootMessageId: { memberId: cursor.memberId, rootMessageId: cursor.rootMessageId },
      },
      create: {
        memberId: cursor.memberId,
        rootMessageId: cursor.rootMessageId,
        conversationId: cursor.conversationId,
        workspaceId,
        readThroughSequence: cursor.readThroughSequence,
        doneThroughSequence: cursor.doneThroughSequence,
      },
      update: {
        readThroughSequence: cursor.readThroughSequence,
        doneThroughSequence: cursor.doneThroughSequence,
      },
    });
  }
  for (const cursor of plan.assistantReadMappings) {
    await tx.workspaceAssistantReadCursor.upsert({
      where: {
        sessionId_conversationId_scope: {
          sessionId: cursor.sessionId,
          conversationId: cursor.conversationId,
          scope: cursor.scope,
        },
      },
      create: {
        sessionId: cursor.sessionId,
        conversationId: cursor.conversationId,
        scope: cursor.scope,
        readThroughSequence: cursor.readThroughSequence,
      },
      update: { readThroughSequence: cursor.readThroughSequence },
    });
  }
  // Drain deferred RI triggers before ALTER TABLE adds the validated metadata FK.
  await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
  const createdAttachmentIndex = await addOrdinaryCommentMetadataKey(tx, scope, before);
  for (const table of [
    "attachment_comment_threads",
    "conversation_members",
    "conversations",
  ] as const) {
    if (table === "conversation_members") {
      for (const dependency of [
        "messages",
        "attachment_comments",
        "message_reactions",
        "message_mentions",
        "saved_messages",
        "thread_reads",
        "thread_follows",
        "workspace_assistant_read_cursors",
      ] as const) {
        const [row] = await tx.$queryRaw<
          { count: bigint }[]
        >(Prisma.sql`SELECT count(*) AS count FROM ${migrationRelation(scope.schema, dependency)}
          WHERE ${migrationIds(Prisma.sql`"conversationId"`, scope.oldConversationIds)}`);
        if (!row || row.count !== 0n)
          throw new Error("Legacy conversation still has dependent rows");
      }
    }
    const column = table === "conversations" ? Prisma.sql`id` : Prisma.sql`"conversationId"`;
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM ${migrationRelation(scope.schema, table)} WHERE ${migrationIds(column, scope.oldConversationIds)}`,
    );
  }
  await finishCommentMigrationKeys(tx, scope, before);
  return { resolvedMembers, createdMemberIds, createdAttachmentIndex };
}

const without = (row: MigrationRow, keys: string[]) =>
  Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
function equal(a: unknown, b: unknown) {
  if (migrationFingerprint(a) !== migrationFingerprint(b))
    throw new Error("Local migration conservation check failed");
}
export function validateAppliedCommentMigration(
  journal: AttachmentCommentMigrationJournal,
  after: CommentMigrationBackup,
) {
  const { scope, before, plan } = journal;
  equal(before.sourceMessages, after.sourceMessages);
  equal(before.attachments, after.attachments);
  equal(
    before.follows.filter(
      (row) => !scope.oldConversationIds.includes(migrationText(row, "conversationId")),
    ),
    after.follows,
  );
  if (after.threads.length || after.messages.length !== before.messages.length)
    throw new Error("Legacy row count changed");
  const members = new Map(
    journal.resolvedMembers.map((row) => [row.fromMemberId, row.targetMemberId]),
  );
  for (const old of before.messages) {
    const row = after.messages.find((entry) => entry.id === old.id);
    const move = plan.moves.find((entry) => entry.messageId === old.id);
    if (
      !row ||
      !move ||
      row.conversationId !== move.conversationId ||
      row.threadRootId !== move.threadRootId ||
      row.sequence !== move.sequence ||
      row.senderMemberId !== members.get(migrationText(old, "senderMemberId"))
    )
      throw new Error("Migrated message identity changed");
    equal(
      without(old, ["conversationId", "threadRootId", "senderMemberId", "sequence"]),
      without(row, ["conversationId", "threadRootId", "senderMemberId", "sequence"]),
    );
  }
  for (const key of ["comments", "reactions", "mentions", "saved"] as const) {
    if (before[key].length !== after[key].length)
      throw new Error("Historical metadata count changed");
    for (const old of before[key]) {
      const moved = scope.messageIds.includes(migrationText(old, "messageId"));
      const actor =
        key === "comments"
          ? undefined
          : moved
            ? members.get(migrationText(old, "memberId"))
            : old.memberId;
      const row = after[key].find(
        (entry) =>
          entry.messageId === old.messageId &&
          (actor === undefined || entry.memberId === actor) &&
          entry.emoji === old.emoji,
      );
      if (!row) throw new Error("Historical metadata actor changed");
      if (
        moved &&
        row.conversationId !==
          plan.moves.find((entry) => entry.messageId === old.messageId)?.conversationId
      )
        throw new Error("Historical metadata scope changed");
      equal(
        without(old, moved ? ["conversationId", "memberId"] : []),
        without(row, moved ? ["conversationId", "memberId"] : []),
      );
    }
  }
  const existing = before.members.filter(
    (row) => !scope.oldConversationIds.includes(migrationText(row, "conversationId")),
  );
  for (const row of existing)
    equal(
      row,
      after.members.find((entry) => entry.id === row.id),
    );
  if (after.members.length !== existing.length + journal.createdMemberIds.length)
    throw new Error("Historical membership count changed");
  for (const id of journal.createdMemberIds) {
    const row = after.members.find((entry) => entry.id === id);
    if (!row || migrationNullableText(row, "leftAt") === null || row.channelRole !== "member")
      throw new Error("Historical seat became active");
  }
  for (const row of before.conversations.filter(
    (entry) => !scope.oldConversationIds.includes(migrationText(entry, "id")),
  )) {
    equal(
      row,
      after.conversations.find((entry) => entry.id === row.id),
    );
  }
  if (
    after.conversations.some((row) => scope.oldConversationIds.includes(migrationText(row, "id")))
  )
    throw new Error("Legacy conversation was not retired");
}

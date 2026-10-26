import { Prisma } from "#src/generated/prisma/client";

type ForeignKey = {
  schema: string;
  table: string;
  constraint: string;
  targetSchema: string;
  target: string;
  columns: string[];
  referencedColumns: string[];
};

// Only these explicit table/column relationships are supported historical data.
const supported = new Set([
  "conversation_members:conversationId,workspaceId->conversations:id,workspaceId",
  "messages:conversationId,workspaceId->conversations:id,workspaceId",
  "attachment_comment_threads:conversationId,workspaceId->conversations:id,workspaceId",
  "messages:senderMemberId,conversationId,workspaceId->conversation_members:id,conversationId,workspaceId",
  "messages:threadRootId,conversationId->messages:id,conversationId",
  "message_reactions:memberId,conversationId,workspaceId->conversation_members:id,conversationId,workspaceId",
  "message_reactions:messageId,conversationId->messages:id,conversationId",
  "message_mentions:memberId,conversationId,workspaceId->conversation_members:id,conversationId,workspaceId",
  "message_mentions:messageId,conversationId->messages:id,conversationId",
  "saved_messages:conversationId,workspaceId->conversations:id,workspaceId",
  "saved_messages:memberId,conversationId,workspaceId->conversation_members:id,conversationId,workspaceId",
  "saved_messages:messageId,conversationId->messages:id,conversationId",
  "thread_reads:memberId,conversationId,workspaceId->conversation_members:id,conversationId,workspaceId",
  "thread_reads:rootMessageId,conversationId->messages:id,conversationId",
  "thread_follows:memberId,conversationId,workspaceId->conversation_members:id,conversationId,workspaceId",
  "thread_follows:rootMessageId,conversationId->messages:id,conversationId",
  "attachment_comments:messageId,conversationId->messages:id,conversationId",
  "attachment_comments:attachmentId,workspaceId,conversationId->attachment_comment_threads:attachmentId,workspaceId,conversationId",
]);

function identifier(value: string): Prisma.Sql {
  return Prisma.raw(`"${value.replaceAll('"', '""')}"`);
}

/** Catalog identifiers are quoted; all row identities remain bound parameters. */
export async function unsupportedCommentMigrationDependencies(
  tx: Prisma.TransactionClient,
  ids: {
    conversations: string[];
    messages: string[];
    members: string[];
    attachments: string[];
    sourceConversations: string[];
  },
) {
  const targets: Record<string, { key: string; ids: string[] }> = {
    message_reactions: { key: "conversationId", ids: ids.conversations },
    message_mentions: { key: "conversationId", ids: ids.conversations },
    saved_messages: { key: "conversationId", ids: ids.conversations },
    thread_reads: {
      key: "conversationId",
      ids: [...ids.conversations, ...ids.sourceConversations],
    },
    thread_follows: { key: "conversationId", ids: ids.conversations },
    workspace_assistant_read_cursors: {
      key: "conversationId",
      ids: [...ids.conversations, ...ids.sourceConversations],
    },
    conversations: { key: "id", ids: ids.conversations },
    messages: { key: "id", ids: ids.messages },
    conversation_members: { key: "id", ids: ids.members },
    attachment_comments: { key: "messageId", ids: ids.messages },
    attachment_comment_threads: { key: "attachmentId", ids: ids.attachments },
  };
  const keys = await tx.$queryRaw<ForeignKey[]>`
    SELECT cn.nspname::text AS schema, child.relname::text AS "table", fk.conname::text AS "constraint",
      pn.nspname::text AS "targetSchema", parent.relname::text AS target,
      array_agg(ca.attname::text ORDER BY k.position) AS columns,
      array_agg(pa.attname::text ORDER BY k.position) AS "referencedColumns"
    FROM pg_constraint fk
    JOIN pg_class child ON child.oid = fk.conrelid
    JOIN pg_namespace cn ON cn.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = fk.confrelid
    JOIN pg_namespace pn ON pn.oid = parent.relnamespace
    JOIN LATERAL unnest(fk.conkey, fk.confkey) WITH ORDINALITY k(child, parent, position) ON true
    JOIN pg_attribute ca ON ca.attrelid = child.oid AND ca.attnum = k.child
    JOIN pg_attribute pa ON pa.attrelid = parent.oid AND pa.attnum = k.parent
    WHERE fk.contype = 'f' AND pn.nspname = current_schema()
      AND parent.relname IN ('messages', 'conversation_members', 'conversations', 'attachment_comments', 'attachment_comment_threads',
        'message_reactions', 'message_mentions', 'saved_messages', 'thread_reads', 'thread_follows', 'workspace_assistant_read_cursors')
    GROUP BY cn.nspname, child.relname, fk.conname, pn.nspname, parent.relname
    ORDER BY cn.nspname, child.relname, fk.conname
  `;
  const dependencies: { schema: string; table: string; constraint: string; count: number }[] = [];
  for (const key of keys) {
    const signature = `${key.table}:${key.columns.join(",")}->${key.target}:${key.referencedColumns.join(",")}`;
    if (key.schema === key.targetSchema && supported.has(signature)) continue;
    const target = targets[key.target];
    if (!target?.ids.length) continue;
    const conditions = key.columns.map(
      (column, index) =>
        Prisma.sql`c.${identifier(column)} = p.${identifier(key.referencedColumns[index]!)}`,
    );
    const [result] = await tx.$queryRaw<{ count: bigint }[]>(Prisma.sql`
      SELECT count(*) AS count FROM ${identifier(key.schema)}.${identifier(key.table)} c
      JOIN ${identifier(key.targetSchema)}.${identifier(key.target)} p ON ${Prisma.join(conditions, " AND ")}
      WHERE p.${identifier(target.key)} IN (
        SELECT id::uuid FROM jsonb_array_elements_text(${JSON.stringify(target.ids)}::jsonb) AS selected(id)
      )
    `);
    if (result && result.count > 0n)
      dependencies.push({
        schema: key.schema,
        table: key.table,
        constraint: key.constraint,
        count: Number(result.count),
      });
  }
  return dependencies;
}

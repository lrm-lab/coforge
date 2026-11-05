import { expect, test } from "bun:test";
import { attachmentCommentsFixture } from "./helpers/attachment-comments-fixture";
import {
  backfillMessageReferences,
  rollbackMessageReferenceBackfill,
  readBackfillReferences,
} from "#src/server/conversations/message-references-backfill.server";

const url = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!url) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");

/** Task #465 step 2: the backfill reads the stored reference tokens a send wrote — `<@channel:
 * uuid:name>` and friends — resolves each by the id it carries, and records every row it actually
 * inserted under its run so `--rollback --run-id` deletes exactly those. */

const senderOf = (f: Awaited<ReturnType<typeof attachmentCommentsFixture>>) =>
  f.conversation.members.find((row) => row.userId === f.owner.id)!;

async function messageWith(
  f: Awaited<ReturnType<typeof attachmentCommentsFixture>>,
  body: string,
  sequence: number,
) {
  return f.db.message.create({
    data: {
      workspaceId: f.workspace.id,
      conversationId: f.conversation.id,
      body,
      sequence,
      senderMemberId: senderOf(f).id,
    },
  });
}

test("a stored token resolves by its id; prose stays unwritten", async () => {
  const f = await attachmentCommentsFixture();
  try {
    await messageWith(f, `see <@channel:${f.conversation.id}:files> and #ghost`, 2);
    const summary = await backfillMessageReferences(f.db, { workspaceId: f.workspace.id });
    expect(summary.resolved).toBe(1);
    expect(summary.rowsWritten).toBe(1);
    const row = await f.db.messageReference.findFirst({ where: { workspaceId: f.workspace.id } });
    expect(row?.kind).toBe("channel");
    expect(row?.targetId).toBe(f.conversation.id);
    expect(row?.raw).toBe(`<@channel:${f.conversation.id}:files>`);
    expect(summary.unresolvedProse).toBeGreaterThan(0);
  } finally {
    await f.close();
  }
});

test("the backfill is idempotent — a second run writes nothing new", async () => {
  const f = await attachmentCommentsFixture();
  try {
    await messageWith(f, `<@channel:${f.conversation.id}:files>`, 2);
    const first = await backfillMessageReferences(f.db, { workspaceId: f.workspace.id });
    const second = await backfillMessageReferences(f.db, { workspaceId: f.workspace.id });
    expect(first.rowsWritten).toBeGreaterThan(0);
    expect(second.rowsWritten).toBe(0);
    expect(second.alreadyWritten).toBeGreaterThan(0);
  } finally {
    await f.close();
  }
});

test("a really-renamed channel's token still resolves by id; a dead target fails", async () => {
  const f = await attachmentCommentsFixture();
  try {
    await f.db.conversation.update({
      where: { id: f.conversation.id },
      data: { channelName: "docs" },
    });
    const renamed = await messageWith(f, `old <@channel:${f.conversation.id}:files>`, 2);
    const gone = await messageWith(f, `dead <@channel:${crypto.randomUUID()}:gone>`, 3);
    const summary = await backfillMessageReferences(f.db, { workspaceId: f.workspace.id });
    const renamedRow = await f.db.messageReference.findFirst({ where: { messageId: renamed.id } });
    expect(renamedRow?.targetId).toBe(f.conversation.id);
    expect(await f.db.messageReference.findFirst({ where: { messageId: gone.id } })).toBeNull();
    expect(summary.failed).toBe(1);
  } finally {
    await f.close();
  }
});

test("a message whose tokens partially resolve counts as a partial failure", async () => {
  const f = await attachmentCommentsFixture();
  try {
    await messageWith(
      f,
      `ok <@channel:${f.conversation.id}:files> dead <@channel:${crypto.randomUUID()}:gone>`,
      2,
    );
    const summary = await backfillMessageReferences(f.db, { workspaceId: f.workspace.id });
    expect(summary.partial).toBe(1);
    expect(summary.rowsWritten).toBe(1);
  } finally {
    await f.close();
  }
});

test("resumed from a non-empty cursor, the run neither repeats nor skips", async () => {
  const f = await attachmentCommentsFixture();
  try {
    for (const [index, tag] of ["a", "b", "c"].entries())
      await messageWith(f, `${tag} <@channel:${f.conversation.id}:files>`, index + 2);
    const first = await backfillMessageReferences(f.db, {
      workspaceId: f.workspace.id,
      batchSize: 1,
      maxMinutes: 0.001,
    });
    expect(first.timedOut || first.cursor).toBeTruthy();
    const afterFirst = await f.db.messageReference.count({
      where: { workspaceId: f.workspace.id },
    });
    await backfillMessageReferences(f.db, {
      workspaceId: f.workspace.id,
      fromMessageId: first.cursor,
    });
    const perMessage = await f.db.messageReference.groupBy({
      by: ["messageId"],
      where: { workspaceId: f.workspace.id },
      _count: true,
    });
    for (const group of perMessage) expect(group._count).toBe(1);
    const again = await backfillMessageReferences(f.db, { workspaceId: f.workspace.id });
    expect(again.rowsWritten).toBe(0);
    void afterFirst;
  } finally {
    await f.close();
  }
});

test("rollback deletes only the rows its run recorded, and the run id it prints rolls back", async () => {
  const f = await attachmentCommentsFixture();
  try {
    const historic = await messageWith(f, `<@channel:${f.conversation.id}:files>`, 2);
    const apply = await backfillMessageReferences(f.db, { workspaceId: f.workspace.id });
    expect(apply.runRecordId).toBeTruthy();
    // A "new send" inside the run's window — not attributed to the run, so it survives a rollback.
    const fresh = await messageWith(f, "new send", 3);
    await f.db.messageReference.create({
      data: {
        messageId: fresh.id,
        conversationId: f.conversation.id,
        workspaceId: f.workspace.id,
        kind: "channel",
        targetId: f.conversation.id,
        raw: "#files",
        ordinal: 0,
      },
    });
    const result = await rollbackMessageReferenceBackfill(f.db, apply.runRecordId!);
    expect(result.deleted).toBe(1);
    expect(await f.db.messageReference.count({ where: { messageId: historic.id } })).toBe(0);
    expect(await f.db.messageReference.count({ where: { messageId: fresh.id } })).toBe(1);
    // A rollback of a run id no run recorded is an error, not a silent no-op.
    await expect(rollbackMessageReferenceBackfill(f.db, crypto.randomUUID())).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test("readBackfillReferences finds every stored token shape in order", () => {
  const channelId = "aaaaaaaa-1111-2222-3333-444444444444";
  const rootId = "bbbbbbbb-1111-2222-3333-444444444444";
  const convId = "cccccccc-1111-2222-3333-444444444444";
  const body = `<@channel:${channelId}:files> <@thread:${channelId}:${rootId}:files> <@task:4> <@task:c:${convId}:other:9> <@task:d:${convId}:peer:2> <@human:${convId}>`;
  const found = readBackfillReferences(body);
  expect(found.map((entry) => entry.reference.kind)).toEqual([
    "channel",
    "thread",
    "task",
    "task",
    "task",
  ]);
  expect(found).toHaveLength(5);
});

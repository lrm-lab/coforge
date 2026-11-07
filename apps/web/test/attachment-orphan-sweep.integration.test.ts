import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import type { BulkFileRemoval } from "#src/server/files/file-storage.server";
import {
  ORPHAN_ATTACHMENT_RETENTION_MS,
  deleteExpiredUploadSessions,
  deleteUnclaimedAttachments,
  expiredUploadSessionCandidates,
  countVerifyingUploadSessionZombies,
  orphanAttachmentCandidates,
  sweepOrphanedAttachmentRows,
  sweepOrphanedUploadSessions,
} from "#src/server/attachments/attachment-orphan-sweep.server";

// Run against a disposable local PostgreSQL:
//   CHANNEL_TEST_DATABASE_URL=postgresql://coforge:...@127.0.0.1:5433/coforge_test \
//     mise exec -- bun test apps/web/test/attachment-orphan-sweep.integration.ts
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const DAY_MS = 86_400_000;
const fixture = {} as {
  workspaceId: string;
  userId: string;
  agentId: string;
  conversationId: string;
  messageId: string;
};

function fakeBulkRemoval() {
  const removed: string[] = [];
  const files: BulkFileRemoval = {
    removeMany: async (keys) => {
      removed.push(...keys);
    },
    removePrefix: async () => {},
  };
  return { files: () => Promise.resolve(files), removed };
}

async function addAttachment(input: { ageDays: number; claimed?: boolean }) {
  const id = crypto.randomUUID();
  const objectKey = `workspaces/${fixture.workspaceId}/attachments/${id}/original`;
  await db.attachment.create({
    data: {
      id,
      workspaceId: fixture.workspaceId,
      conversationId: fixture.conversationId,
      uploaderId: fixture.userId,
      objectKey,
      fileName: "orphan.bin",
      contentType: "application/octet-stream",
      sizeBytes: 10,
      createdAt: new Date(Date.now() - input.ageDays * DAY_MS),
      ...(input.claimed ? { messageId: fixture.messageId, position: 0 } : {}),
    },
  });
  return { id, objectKey };
}

async function addUploadSession(input: { state?: string; expiresInMs?: number }) {
  const attachmentId = crypto.randomUUID();
  const objectKey = `workspaces/${fixture.workspaceId}/attachments/${attachmentId}/original`;
  const session = await db.attachmentUploadSession.create({
    data: {
      workspaceId: fixture.workspaceId,
      conversationId: fixture.conversationId,
      agentId: fixture.agentId,
      attachmentId,
      objectKey,
      fileName: "upload.bin",
      contentType: "application/octet-stream",
      sizeBytes: 10,
      idempotencyKey: crypto.randomUUID(),
      state: input.state ?? "pending",
      expiresAt: new Date(Date.now() + (input.expiresInMs ?? 3_600_000)),
    },
  });
  return { id: session.id, objectKey };
}

beforeAll(async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({
    data: { displayName: `orphan_${suffix}`, username: `orphan_${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `orphan-${suffix}`,
      name: "Attachment orphan sweep integration",
      members: { create: { userId: user.id } },
    },
  });
  const computer = await db.computer.create({
    data: {
      ownerId: user.id,
      machineId: `machine-${suffix}`,
      workspaces: { create: { workspaceId: workspace.id } },
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: user.id,
      computerId: computer.id,
      name: "uploader",
      displayName: "Uploader",
      runtimeConfig: {},
    },
  });
  const conversation = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `general-${suffix}`,
      members: {
        create: [
          { workspace: { connect: { id: workspace.id } }, agent: { connect: { id: agent.id } } },
          { workspace: { connect: { id: workspace.id } }, user: { connect: { id: user.id } } },
        ],
      },
    },
  });
  const message = await db.message.create({
    data: {
      conversationId: conversation.id,
      workspaceId: workspace.id,
      body: "claimed",
      sequence: 1,
    },
  });
  fixture.workspaceId = workspace.id;
  fixture.userId = user.id;
  fixture.agentId = agent.id;
  fixture.conversationId = conversation.id;
  fixture.messageId = message.id;
});

afterAll(async () => {
  await db.workspace.deleteMany({ where: { id: fixture.workspaceId } });
  await db.$disconnect();
});

test("the sweep deletes unclaimed attachments past retention and removes their objects", async () => {
  const old = await addAttachment({ ageDays: 8 });
  const young = await addAttachment({ ageDays: 1 });
  const claimed = await addAttachment({ ageDays: 30, claimed: true });
  const { files, removed } = fakeBulkRemoval();

  const stats = await sweepOrphanedAttachmentRows(db, files, new Date());

  expect(stats.deleted).toBeGreaterThanOrEqual(1);
  expect(await db.attachment.findUnique({ where: { id: old.id } })).toBeNull();
  expect(await db.attachment.findUnique({ where: { id: young.id } })).not.toBeNull();
  expect(await db.attachment.findUnique({ where: { id: claimed.id } })).not.toBeNull();
  expect(removed).toContain(old.objectKey);
  expect(removed).not.toContain(young.objectKey);
  expect(removed).not.toContain(claimed.objectKey);
});

test("a row a send claims between the candidate read and the delete survives", async () => {
  const raced = await addAttachment({ ageDays: 9 });
  const cutoff = new Date(Date.now() - ORPHAN_ATTACHMENT_RETENTION_MS);
  const candidates = await orphanAttachmentCandidates(db, cutoff, 500);
  const mine = candidates.find((row) => row.id === raced.id);
  expect(mine).toBeDefined();

  // The send commits its claim after the sweep read its candidates.
  await db.attachment.update({
    where: { id: raced.id },
    data: { messageId: fixture.messageId, position: 0 },
  });

  const deletedKeys = await deleteUnclaimedAttachments(db, mine ? [mine] : []);
  expect(deletedKeys).toEqual([]);
  expect(await db.attachment.findUnique({ where: { id: raced.id } })).not.toBeNull();
});

test("a batch delete reports only the rows it actually removed", async () => {
  const doomed = await addAttachment({ ageDays: 10 });
  const spared = await addAttachment({ ageDays: 11 });
  const cutoff = new Date(Date.now() - ORPHAN_ATTACHMENT_RETENTION_MS);
  const candidates = await orphanAttachmentCandidates(db, cutoff, 500);
  const batch = candidates.filter((row) => row.id === doomed.id || row.id === spared.id);
  expect(batch).toHaveLength(2);

  // `spared` is claimed after the candidate read, inside the same batch.
  await db.attachment.update({
    where: { id: spared.id },
    data: { messageId: fixture.messageId, position: 0 },
  });

  const deletedKeys = await deleteUnclaimedAttachments(db, batch);
  expect(deletedKeys).toEqual([doomed.objectKey]);
  expect(await db.attachment.findUnique({ where: { id: doomed.id } })).toBeNull();
  expect(await db.attachment.findUnique({ where: { id: spared.id } })).not.toBeNull();
});

test("the session sweep deletes expired pending sessions and removes their objects", async () => {
  const expiredPending = await addUploadSession({ expiresInMs: -1_000 });
  const livePending = await addUploadSession({ expiresInMs: 3_600_000 });
  const expiredVerifying = await addUploadSession({ state: "verifying", expiresInMs: -1_000 });
  const canceled = await addUploadSession({ state: "canceled", expiresInMs: -3_600_000 });
  const { files, removed } = fakeBulkRemoval();

  const stats = await sweepOrphanedUploadSessions(db, files, new Date());

  expect(stats.deleted).toBeGreaterThanOrEqual(1);
  expect(
    await db.attachmentUploadSession.findUnique({ where: { id: expiredPending.id } }),
  ).toBeNull();
  expect(
    await db.attachmentUploadSession.findUnique({ where: { id: livePending.id } }),
  ).not.toBeNull();
  // `verifying` zombies are only counted in v1, never deleted.
  expect(
    await db.attachmentUploadSession.findUnique({ where: { id: expiredVerifying.id } }),
  ).not.toBeNull();
  expect(
    await db.attachmentUploadSession.findUnique({ where: { id: canceled.id } }),
  ).not.toBeNull();
  expect(removed).toContain(expiredPending.objectKey);
  expect(removed).not.toContain(livePending.objectKey);
  expect(removed).not.toContain(expiredVerifying.objectKey);
  expect(removed).not.toContain(canceled.objectKey);
});

test("a session claimed between the candidate read and the delete survives", async () => {
  const raced = await addUploadSession({ expiresInMs: -1_000 });
  const candidates = await expiredUploadSessionCandidates(db, new Date(), 500);
  const mine = candidates.find((row) => row.id === raced.id);
  expect(mine).toBeDefined();

  // `complete` claims the session for verification after the sweep read its candidates.
  await db.attachmentUploadSession.updateMany({
    where: { id: raced.id, state: "pending" },
    data: { state: "verifying" },
  });

  const deletedKeys = await deleteExpiredUploadSessions(db, mine ? [mine] : []);
  expect(deletedKeys).toEqual([]);
  expect(await db.attachmentUploadSession.findUnique({ where: { id: raced.id } })).not.toBeNull();
});

test("the sweep counts verifying sessions stuck for over an hour", async () => {
  const before = await countVerifyingUploadSessionZombies(db, new Date());
  const stuck = await addUploadSession({ state: "verifying", expiresInMs: 3_600_000 });
  const fresh = await addUploadSession({ state: "verifying", expiresInMs: 3_600_000 });
  await db.$executeRaw`UPDATE attachment_upload_sessions SET "updatedAt" = ${new Date(Date.now() - 2 * 3_600_000)} WHERE id = ${stuck.id}`;

  const after = await countVerifyingUploadSessionZombies(db, new Date());
  expect(after).toBe(before + 1);
  expect(await db.attachmentUploadSession.findUnique({ where: { id: fresh.id } })).not.toBeNull();
});

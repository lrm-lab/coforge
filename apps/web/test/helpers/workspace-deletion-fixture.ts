import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import { prepareDaemonApiKey } from "#src/server/auth/daemon-api-key.server";
import { PrismaWorkspaceMemoryCleanupStore } from "#src/server/db/repositories/workspace-memory-cleanup.repositories.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import {
  createFakeWorkspaceMemoryCleanupRemotes,
  createWorkspaceMemoryCleanup,
} from "#src/server/workspace-memory/cleanup.server";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import {
  WorkspaceDeletion,
  type WorkspaceDeletionSignals,
  type WorkspaceFileRemoval,
} from "#src/server/workspaces/deletion.server";

/**
 * The Workspace a deletion test deletes, and the effects a deletion reaches, recording what they
 * are asked. Shared by `workspace-delete.integration.test.ts` and
 * `workspace-delete-memory.integration.test.ts`.
 *
 * `setup()` needs `CHANNEL_TEST_DATABASE_URL` pointing at local PostgreSQL; the tests skip without it.
 */
export const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

export async function errorIdOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return { code: error.code, errorId: error.errorId };
    throw error;
  }
  return undefined;
}

const silentRealtime: ConversationRealtime = {
  async messageAvailable() {},
  async memberChanged() {},
};

/** File removal that records what it was asked, and finishes only when released: the delete
 * must answer without waiting for it. */
export function recordingFileRemoval() {
  const calls: { workspaceId: string; files: string[]; images: string[] }[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const removal: WorkspaceFileRemoval = {
    remove(workspaceId, keys) {
      calls.push({ workspaceId, files: [...keys.files].sort(), images: [...keys.images].sort() });
      return released;
    },
  };
  return { calls, removal, release };
}

/** Signals that record who heard of the delete. */
export function recordingSignals() {
  const deleted: string[] = [];
  const reconnected: { workspaceId: string; computerIds: string[] }[] = [];
  const signals: WorkspaceDeletionSignals = {
    async workspaceDeleted(workspaceId) {
      deleted.push(workspaceId);
    },
    async reconnectDaemons(workspaceId, computerIds) {
      reconnected.push({ workspaceId, computerIds: [...computerIds] });
    },
  };
  return { deleted, reconnected, signals };
}

/** A deletion whose effects go nowhere, for tests about the rows. */
export function quietDeletion(db: PrismaClient) {
  return new WorkspaceDeletion(db, {
    files: recordingFileRemoval().removal,
    signals: recordingSignals().signals,
    memory: unboundMemory(db).memory,
  });
}

/** Memory removal over the real cleanup rows whose remotes only record their calls: what a
 * Workspace with no memory must never reach. */
export function unboundMemory(db: PrismaClient) {
  const remotes = createFakeWorkspaceMemoryCleanupRemotes();
  const memory = createWorkspaceMemoryCleanup({
    store: new PrismaWorkspaceMemoryCleanupStore(db),
    remotes,
  });
  return { remotes, memory };
}

/** A Workspace in use: an owner, an admin and a member who wrote in a channel, an Agent on a
 * Computer with a live daemon key, and one of everything that hangs off them. */
export async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: `wd-owner-${suffix}`, username: `wd-owner-${suffix}` },
  });
  const admin = await db.user.create({
    data: { displayName: `wd-admin-${suffix}`, username: `wd-admin-${suffix}` },
  });
  const member = await db.user.create({
    data: { displayName: `wd-member-${suffix}`, username: `wd-member-${suffix}` },
  });
  const catalog = new PrismaWorkspaceCatalogStore(db);
  const workspace = await catalog.createForUser({
    slug: `wd-${suffix}`,
    name: "Doomed",
    userId: owner.id,
  });
  await db.workspaceMembership.createMany({
    data: [
      { workspaceId: workspace.id, userId: admin.id, role: "admin" },
      { workspaceId: workspace.id, userId: member.id, role: "member" },
    ],
  });
  const computer = await db.computer.create({
    data: { ownerId: owner.id, machineId: `machine-${suffix}` },
  });
  await db.workspaceComputer.create({
    data: { workspaceId: workspace.id, computerId: computer.id },
  });
  const liveKey = prepareDaemonApiKey({
    principal: { userId: owner.id },
    workspaceId: workspace.id,
    computerId: computer.id,
  });
  await db.daemonApiKey.create({ data: liveKey.record });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      name: `wd-agent-${suffix}`,
      displayName: "Helper",
      ownerId: owner.id,
      computerId: computer.id,
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
    },
  });
  const workspaceIconKey = `workspaces/${workspace.id}/icons/${crypto.randomUUID()}/original`;
  await db.workspace.update({
    where: { id: workspace.id },
    data: { iconObjectKey: workspaceIconKey, iconContentType: "image/png" },
  });
  const projectIconKey = `workspaces/${workspace.id}/projects/p/icons/${crypto.randomUUID()}/original`;
  await db.project.create({
    data: {
      workspaceId: workspace.id,
      name: "Site",
      slug: `site-${suffix}`,
      iconObjectKey: projectIconKey,
      iconContentType: "image/png",
    },
  });

  const channels = new PublicChannels(db, undefined, undefined, undefined, silentRealtime);
  const team = await channels.create(workspace.id, member.id, `team-${suffix}`);
  await channels.addMembers(workspace.id, { userId: member.id }, team.id, {
    userIds: [],
    agentIds: [agent.id],
  });
  // The channel's coordinator names the Agent without cascading (`NO ACTION`).
  await db.conversation.update({ where: { id: team.id }, data: { coordinatorAgentId: agent.id } });
  // An app the Workspace registered, installed there, with a logo; all of it goes with it.
  const appLogoKey = `workspaces/${workspace.id}/apps/own-app-${suffix}/logos/${crypto.randomUUID()}/original`;
  await db.app.create({
    data: {
      key: `own-app-${suffix}`,
      ownerWorkspaceId: workspace.id,
      name: "Own app",
      homepageUrl: "https://own.example/",
      redirectUris: ["https://own.example/callback"],
      allowedScopes: ["openid"],
      clientSecretHash: "0".repeat(64),
      logoObjectKey: appLogoKey,
      logoContentType: "image/png",
      installations: { create: { workspaceId: workspace.id } },
    },
  });
  const memberRow = await db.conversationMember.findUniqueOrThrow({
    where: { conversationId_userId: { conversationId: team.id, userId: member.id } },
  });
  const agentRow = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: team.id, agentId: agent.id },
  });
  const written = await db.message.create({
    data: {
      workspaceId: workspace.id,
      conversationId: team.id,
      senderMemberId: memberRow.id,
      sequence: 1,
      body: "the member wrote this",
    },
  });
  await db.message.create({
    data: {
      workspaceId: workspace.id,
      conversationId: team.id,
      senderMemberId: memberRow.id,
      sequence: 2,
      body: "and replied",
      threadRootId: written.id,
    },
  });
  await new TaskBoard(db).execute(
    { workspaceId: workspace.id, userId: member.id },
    {
      operation: "create",
      conversationId: team.id,
      title: "a task the member owns",
      idempotencyKey: crypto.randomUUID(),
      assignee: `@${member.username}`,
    },
  );
  const prepared = await db.message.create({
    data: {
      workspaceId: workspace.id,
      conversationId: team.id,
      senderMemberId: agentRow.id,
      sequence: 10,
      body: "shall I create a channel?",
    },
  });
  await db.actionCard.create({
    data: {
      messageId: prepared.id,
      conversationId: team.id,
      workspaceId: workspace.id,
      kind: "channel:create",
      payload: { name: "later" },
      preparedByAgentId: agent.id,
    },
  });
  const attachmentKey = `workspaces/${workspace.id}/attachments/${crypto.randomUUID()}/original`;
  await db.attachment.create({
    data: {
      workspaceId: workspace.id,
      conversationId: team.id,
      messageId: written.id,
      fileName: "notes.txt",
      contentType: "text/plain",
      sizeBytes: 4,
      objectKey: attachmentKey,
    },
  });
  const uploadKey = `workspaces/${workspace.id}/attachments/${crypto.randomUUID()}/original`;
  await db.attachmentUploadSession.create({
    data: {
      workspaceId: workspace.id,
      conversationId: team.id,
      agentId: agent.id,
      attachmentId: crypto.randomUUID(),
      objectKey: uploadKey,
      fileName: "draft.txt",
      contentType: "text/plain",
      sizeBytes: 5,
      idempotencyKey: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  await db.reminder.create({
    data: {
      workspaceId: workspace.id,
      ownerAgentId: agent.id,
      computerId: computer.id,
      title: "ping",
      target: `#team-${suffix}`,
      messageId: written.id,
      fireAt: new Date(Date.now() + 3_600_000),
    },
  });
  const cycle = await db.weeklyReportCycle.create({
    data: { workspaceId: workspace.id, year: 2026, week: 40, title: "W40", createdById: member.id },
  });
  await db.weeklyReport.create({
    data: {
      workspaceId: workspace.id,
      cycleId: cycle.id,
      authorId: member.id,
      kind: "member",
      title: "My week",
      content: {},
    },
  });
  await db.recordNote.create({
    data: { workspaceId: workspace.id, authorId: member.id, title: "note" },
  });
  // A Memory Offer citing a memory record: the citation names the record with `Restrict`.
  await db.openVikingCitationRecord.create({
    data: {
      workspaceId: workspace.id,
      citationId: "cite-1",
      accountId: "acct",
      uri: "viking://x",
      matchedLevel: "L1",
      contentHash: "sha256:x",
      title: "A remembered decision",
      boundOperationId: "op-1",
    },
  });
  await db.memoryOfferRecord.create({
    data: {
      workspaceId: workspace.id,
      operationId: "offer-1",
      conversationId: team.id,
      recipientAgentId: agent.id,
      recipientRationale: "asked",
      messageId: written.id,
    },
  });
  await db.memoryOfferCitation.create({
    data: {
      workspaceId: workspace.id,
      offerOperationId: "offer-1",
      citationKind: "openviking",
      citationId: "cite-1",
      openvikingCitationId: "cite-1",
    },
  });

  const cleanup = async () => {
    // A Workspace left behind by a failed test keeps its cleanup rows with `Restrict`.
    await db.workspaceMemoryCleanupWork
      .deleteMany({ where: { workspaceId: workspace.id } })
      .catch(() => {});
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
    await db.daemonCredentialRevocation
      .deleteMany({ where: { apiKeyHash: liveKey.record.apiKeyHash } })
      .catch(() => {});
    await db.computer.deleteMany({ where: { ownerId: owner.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, admin.id, member.id] } } });
    await db.$disconnect();
  };
  return {
    db,
    workspace,
    owner,
    admin,
    member,
    liveKeyHash: liveKey.record.apiKeyHash,
    computerId: computer.id,
    team,
    memberRowId: memberRow.id,
    privateKeys: [attachmentKey, uploadKey],
    imageKeys: [workspaceIconKey, projectIconKey, appLogoKey],
    cleanup,
  };
}

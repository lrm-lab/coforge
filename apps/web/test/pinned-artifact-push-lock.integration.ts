import { afterAll, beforeAll, expect, test } from "bun:test";
import { agentDirectKey } from "#src/features/conversations/direct-key";
import { AgentChannelManagement } from "#src/server/conversations/agent-channel-management.server";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";

let f: CommentsFixture;
let dmId: string;

beforeAll(async () => {
  f = await commentsFixture("pal");
  const dm = await f.db.conversation.create({
    data: {
      workspaceId: f.workspaceId,
      directKey: agentDirectKey(f.alice, f.agents.writer),
    },
    select: { id: true },
  });
  await f.db.conversationMember.createMany({
    data: [
      { conversationId: dm.id, workspaceId: f.workspaceId, userId: f.alice },
      { conversationId: dm.id, workspaceId: f.workspaceId, agentId: f.agents.writer },
    ],
  });
  dmId = dm.id;
});

afterAll(() => f.cleanup());

test("DM-pinned artifact push lock refuses archived, non-participant, private-Agent, and departed-peer DMs", async () => {
  const management = new AgentChannelManagement(f.db);
  const aliceUser = await f.db.user.findUniqueOrThrow({
    where: { id: f.alice },
    select: { username: true },
  });
  const dmDocId = await f.make("DM Lock Doc", undefined, {
    target: `@${aliceUser.username}`,
    by: f.agents.writer,
  });
  await management.update(f.workspaceId, f.agents.writer, `@${aliceUser.username}`, {
    announcement: dmDocId,
  });

  await f.db.conversation.update({
    where: { id: dmId },
    data: { archivedAt: new Date() },
  });
  try {
    const archivedDmPush = await f.post(f.agents.writer, {
      operation: "push",
      idempotencyKey: f.key(),
      artifact: dmDocId,
      baseVersion: 1,
      note: "Push while DM is archived",
      files: await f.manifestOf(f.agents.writer, { "plan.md": "# Archived DM\n" }),
    });
    expect(archivedDmPush.status).toBe(403);
    expect(archivedDmPush.body.details).toMatchObject({
      channel: `dm:@${aliceUser.username}`,
      reason: "archived",
    });
  } finally {
    await f.db.conversation.update({
      where: { id: dmId },
      data: { archivedAt: null },
    });
  }

  await f.db.artifact.update({
    where: { id: dmDocId },
    data: { access: "workspace" },
  });
  const nonParticipantDmPush = await f.post(f.agents.reader, {
    operation: "push",
    idempotencyKey: f.key(),
    artifact: dmDocId,
    baseVersion: 1,
    note: "Non-participant push to DM-pinned workspace artifact",
    files: await f.manifestOf(f.agents.reader, { "plan.md": "# Outsider edit\n" }),
  });
  expect(nonParticipantDmPush.status).toBe(403);
  expect(nonParticipantDmPush.body.details).toEqual({
    channel: "that DM",
    reason: "not_member",
  });
  expect(nonParticipantDmPush.body.error).not.toContain(aliceUser.username);

  const bobUser = await f.db.user.findUniqueOrThrow({
    where: { id: f.bob },
    select: { username: true },
  });
  const bobDm = await f.db.conversation.create({
    data: {
      workspaceId: f.workspaceId,
      directKey: agentDirectKey(f.bob, f.agents.writer),
    },
    select: { id: true },
  });
  await f.db.conversationMember.createMany({
    data: [
      { conversationId: bobDm.id, workspaceId: f.workspaceId, userId: f.bob },
      { conversationId: bobDm.id, workspaceId: f.workspaceId, agentId: f.agents.writer },
    ],
  });
  const bobDmDocId = await f.make("Bob DM Doc", undefined, {
    target: `@${bobUser.username}`,
    by: f.agents.writer,
  });
  await management.update(f.workspaceId, f.agents.writer, `@${bobUser.username}`, {
    announcement: bobDmDocId,
  });
  await f.db.agent.update({
    where: { id: f.agents.writer },
    data: { visibility: "private" },
  });
  try {
    const privateAgentDmPush = await f.post(f.agents.writer, {
      operation: "push",
      idempotencyKey: f.key(),
      artifact: bobDmDocId,
      baseVersion: 1,
      note: "Private Agent cannot push to non-owner DM pinned artifact",
      files: await f.manifestOf(f.agents.writer, { "plan.md": "# Private agent DM\n" }),
    });
    expect(privateAgentDmPush.status).toBe(403);
    expect(privateAgentDmPush.body.details).toMatchObject({
      channel: `dm:@${bobUser.username}`,
      reason: "not_member",
    });
  } finally {
    await f.db.agent.update({
      where: { id: f.agents.writer },
      data: { visibility: "public" },
    });
  }

  const departedUser = await f.db.user.create({
    data: { username: `departed-${f.key().slice(0, 8)}`, displayName: "Departed" },
    select: { id: true, username: true },
  });
  try {
    await f.db.workspaceMembership.create({
      data: { workspaceId: f.workspaceId, userId: departedUser.id, role: "member" },
    });
    const departedDm = await f.db.conversation.create({
      data: {
        workspaceId: f.workspaceId,
        directKey: agentDirectKey(departedUser.id, f.agents.writer),
      },
      select: { id: true },
    });
    await f.db.conversationMember.createMany({
      data: [
        { conversationId: departedDm.id, workspaceId: f.workspaceId, userId: departedUser.id },
        { conversationId: departedDm.id, workspaceId: f.workspaceId, agentId: f.agents.writer },
      ],
    });
    const departedDmDocId = await f.make("Departed DM Doc", undefined, {
      target: `@${departedUser.username}`,
      by: f.agents.writer,
    });
    await management.update(f.workspaceId, f.agents.writer, `@${departedUser.username}`, {
      announcement: departedDmDocId,
    });
    await f.db.conversationMember.updateMany({
      where: { conversationId: departedDm.id, userId: departedUser.id },
      data: { leftAt: new Date() },
    });
    await f.db.workspaceMembership.delete({
      where: { workspaceId_userId: { workspaceId: f.workspaceId, userId: departedUser.id } },
    });
    const departedPeerPush = await f.post(f.agents.writer, {
      operation: "push",
      idempotencyKey: f.key(),
      artifact: departedDmDocId,
      baseVersion: 1,
      note: "Push after DM peer left Workspace",
      files: await f.manifestOf(f.agents.writer, { "plan.md": "# After peer left\n" }),
    });
    expect(departedPeerPush.status).toBe(403);
    expect(departedPeerPush.body.details).toMatchObject({
      channel: `dm:@${departedUser.username}`,
      reason: "peer_not_member",
    });
  } finally {
    await f.db.user.delete({ where: { id: departedUser.id } });
  }
});

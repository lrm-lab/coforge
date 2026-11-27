import { afterAll, beforeAll, expect, test } from "bun:test";
import { isAppError } from "#src/lib/app-error";
import { agentDirectKey } from "#src/features/conversations/direct-key";
import { handleAgentChannelPatch } from "#src/routes/api/agent/v1/channels_.$channel";
import { listAgentWorkspaceChannels } from "#src/server/agents/agent-workspace-roster.server";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { AgentChannelManagement } from "#src/server/conversations/agent-channel-management.server";
import { AgentChannelManagementError } from "#src/server/conversations/agent-channel-management-error.server";
import {
  readConversationPinnedArtifact,
  setConversationPinnedArtifact,
} from "#src/server/conversations/conversation-pinned-artifact.server";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";

let f: CommentsFixture;
let docsChannelId: string;
let dmId: string;

beforeAll(async () => {
  f = await commentsFixture("pa");
  const docsChannel = await f.db.conversation.findFirstOrThrow({
    where: { workspaceId: f.workspaceId, channelName: f.docsChannel },
    select: { id: true },
  });
  docsChannelId = docsChannel.id;
  await f.db.conversationMember.updateMany({
    where: { conversationId: docsChannelId, agentId: f.agents.writer },
    data: { channelRole: "admin" },
  });

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

test("channel admin can pin, replace, and unpin; seen tracks viewer position across versions", async () => {
  const firstId = await f.make("Release Checklist", undefined, { target: `#${f.docsChannel}` });
  const secondId = await f.make("Ops Board", undefined, { target: `#${f.docsChannel}` });

  const initial = await readConversationPinnedArtifact(f.db, {
    workspaceId: f.workspaceId,
    conversationId: docsChannelId,
    userId: f.alice,
  });
  expect(initial).toEqual({ pinned: null, canEdit: true });

  const pinnedEvents: unknown[] = [];
  const realtime = {
    messageAvailable: async (payload: unknown) => {
      pinnedEvents.push(payload);
    },
    memberChanged: async () => undefined,
  };

  const setResult = await setConversationPinnedArtifact(f.db, realtime, {
    workspaceId: f.workspaceId,
    conversationId: docsChannelId,
    userId: f.alice,
    artifactId: firstId,
  });
  expect(setResult.canEdit).toBe(true);
  expect(setResult.pinned).toMatchObject({
    artifactId: firstId,
    title: "Release Checklist",
    version: 1,
    seen: false,
  });
  expect(pinnedEvents).toHaveLength(1);

  const repeatResult = await setConversationPinnedArtifact(f.db, realtime, {
    workspaceId: f.workspaceId,
    conversationId: docsChannelId,
    userId: f.alice,
    artifactId: firstId,
  });
  expect(repeatResult.pinned?.artifactId).toBe(firstId);
  expect(pinnedEvents).toHaveLength(1);

  await productionArtifacts(f.db).viewerPositions.open({
    workspaceId: f.workspaceId,
    artifactId: firstId,
    userId: f.alice,
    version: 1,
  });
  const afterOpen = await readConversationPinnedArtifact(f.db, {
    workspaceId: f.workspaceId,
    conversationId: docsChannelId,
    userId: f.alice,
  });
  expect(afterOpen.pinned?.seen).toBe(true);

  const pushRes = await f.post(f.agents.writer, {
    operation: "push",
    idempotencyKey: f.key(),
    artifact: firstId,
    baseVersion: 1,
    note: "Added staging rollback step",
    files: await f.manifestOf(f.agents.writer, { "plan.md": "# Release\n\nUpdated body\n" }),
  });
  expect(pushRes.status).toBe(200);

  const nonAdminPush = await f.post(f.agents.reader, {
    operation: "push",
    idempotencyKey: f.key(),
    artifact: firstId,
    baseVersion: 2,
    note: "Unauthorized update",
    files: await f.manifestOf(f.agents.reader, { "plan.md": "# Release\n\nNon-admin edit\n" }),
  });
  expect(nonAdminPush.status).toBe(403);
  expect(nonAdminPush.body.error).toContain("channel-announcement-push-forbidden");
  const afterPush = await readConversationPinnedArtifact(f.db, {
    workspaceId: f.workspaceId,
    conversationId: docsChannelId,
    userId: f.alice,
  });
  expect(afterPush.pinned).toMatchObject({
    artifactId: firstId,
    version: 2,
    note: "Added staging rollback step",
    seen: false,
  });

  const replaced = await setConversationPinnedArtifact(f.db, realtime, {
    workspaceId: f.workspaceId,
    conversationId: docsChannelId,
    userId: f.alice,
    artifactId: secondId,
  });
  expect(replaced.pinned?.artifactId).toBe(secondId);
  expect(pinnedEvents).toHaveLength(2);

  const removed = await setConversationPinnedArtifact(f.db, realtime, {
    workspaceId: f.workspaceId,
    conversationId: docsChannelId,
    userId: f.alice,
    artifactId: null,
  });
  expect(removed).toEqual({ pinned: null, canEdit: true });
  expect(pinnedEvents).toHaveLength(3);

  await f.db.artifactReadPosition.upsert({
    where: { artifactId_agentId: { artifactId: firstId, agentId: f.agents.reader } },
    create: { artifactId: firstId, agentId: f.agents.reader, version: 2 },
    update: { version: 2 },
  });
  const afterUnpinPush = await f.post(f.agents.reader, {
    operation: "push",
    idempotencyKey: f.key(),
    artifact: firstId,
    baseVersion: 2,
    note: "Allowed after unpin",
    files: await f.manifestOf(f.agents.reader, { "plan.md": "# Release\n\nAfter unpin\n" }),
  });
  expect(afterUnpinPush.status).toBe(200);

  const notices = await f.db.systemMessage.findMany({
    where: { conversationId: docsChannelId, kind: "conversation.pinned_artifact_changed" },
    orderBy: { createdAt: "asc" },
    select: { params: true },
  });
  expect(notices.map((row) => (row.params as { change: string }).change)).toEqual([
    "set",
    "replaced",
    "removed",
  ]);
});

test("non-admin member cannot pin, foreign artifacts are refused, and deleted pinned artifact reads as null", async () => {
  const docsArtifact = await f.make("Channel Doc", undefined, { target: `#${f.docsChannel}` });
  const privateArtifact = await f.make("Private Doc", undefined, {
    target: `#${f.privateChannel}`,
  });

  const bobRead = await readConversationPinnedArtifact(f.db, {
    workspaceId: f.workspaceId,
    conversationId: docsChannelId,
    userId: f.bob,
  });
  expect(bobRead.canEdit).toBe(false);

  try {
    await setConversationPinnedArtifact(f.db, undefined, {
      workspaceId: f.workspaceId,
      conversationId: docsChannelId,
      userId: f.bob,
      artifactId: docsArtifact,
    });
    expect.unreachable("non-admin should be rejected");
  } catch (error) {
    expect(isAppError(error) && error.code).toBe("ACCESS_DENIED");
  }

  try {
    await setConversationPinnedArtifact(f.db, undefined, {
      workspaceId: f.workspaceId,
      conversationId: docsChannelId,
      userId: f.alice,
      artifactId: privateArtifact,
    });
    expect.unreachable("artifact from another conversation should be rejected");
  } catch (error) {
    expect(isAppError(error) && error.code).toBe("NOT_FOUND");
  }

  await setConversationPinnedArtifact(f.db, undefined, {
    workspaceId: f.workspaceId,
    conversationId: docsChannelId,
    userId: f.alice,
    artifactId: docsArtifact,
  });
  await productionArtifacts(f.db).artifacts.delete({
    workspaceId: f.workspaceId,
    artifactId: docsArtifact,
    actor: { userId: f.alice },
  });
  const afterDelete = await readConversationPinnedArtifact(f.db, {
    workspaceId: f.workspaceId,
    conversationId: docsChannelId,
    userId: f.alice,
  });
  expect(afterDelete.pinned).toBeNull();
});

test("DM participant can pin and unpin while non-participant cannot access", async () => {
  const dmArtifact = await f.db.artifact.create({
    data: {
      workspaceId: f.workspaceId,
      homeKey: `conversation:${dmId}`,
      name: "dm-plan",
      title: "Weekly Plan",
      entryPath: "plan.md",
      authorAgentId: f.agents.writer,
      currentVersion: 1,
      preview: "Plan summary",
      versions: {
        create: {
          number: 1,
          publisherAgentId: f.agents.writer,
          note: "Initial plan",
          entryPath: "plan.md",
          title: "Weekly Plan",
          changedPaths: ["plan.md"],
          idempotencyKey: f.key(),
        },
      },
    },
    select: { id: true },
  });

  const pinned = await setConversationPinnedArtifact(f.db, undefined, {
    workspaceId: f.workspaceId,
    conversationId: dmId,
    userId: f.alice,
    artifactId: dmArtifact.id,
  });
  expect(pinned.canEdit).toBe(true);
  expect(pinned.pinned?.title).toBe("Weekly Plan");

  try {
    await readConversationPinnedArtifact(f.db, {
      workspaceId: f.workspaceId,
      conversationId: dmId,
      userId: f.bob,
    });
    expect.unreachable("non-member of DM should get NOT_FOUND");
  } catch (error) {
    expect(isAppError(error) && error.code).toBe("NOT_FOUND");
  }

  await f.db.agent.update({
    where: { id: f.agents.writer },
    data: { deletedAt: new Date() },
  });
  try {
    const readDeleted = await readConversationPinnedArtifact(f.db, {
      workspaceId: f.workspaceId,
      conversationId: dmId,
      userId: f.alice,
    });
    expect(readDeleted.canEdit).toBe(false);
    expect(readDeleted.pinned?.title).toBe("Weekly Plan");

    try {
      await setConversationPinnedArtifact(f.db, undefined, {
        workspaceId: f.workspaceId,
        conversationId: dmId,
        userId: f.alice,
        artifactId: null,
      });
      expect.unreachable("deleted Agent DM should be read-only");
    } catch (error) {
      expect(isAppError(error) && error.code).toBe("ACCESS_DENIED");
    }
  } finally {
    await f.db.agent.update({
      where: { id: f.agents.writer },
      data: { deletedAt: null },
    });
  }

  const outsider = await f.db.user.create({
    data: {
      username: `outsider-${f.key().slice(0, 8)}`,
      displayName: "Outsider",
    },
    select: { id: true },
  });
  try {
    await readConversationPinnedArtifact(f.db, {
      workspaceId: f.workspaceId,
      conversationId: docsChannelId,
      userId: outsider.id,
    });
    expect.unreachable("non-workspace member should get NOT_FOUND");
  } catch (error) {
    expect(isAppError(error) && error.code).toBe("NOT_FOUND");
  }
});

test("Agent CLI channel update, info, workspace roster, DM pin, and DM push-lock exemption align with Raft", async () => {
  const management = new AgentChannelManagement(f.db);
  const channelDocId = await f.make("Agent Pinned Guide", undefined, {
    target: `#${f.docsChannel}`,
  });
  const foreignDocId = await f.make("Foreign Private Guide", undefined, {
    target: `#${f.privateChannel}`,
  });

  const updated = await management.update(f.workspaceId, f.agents.writer, `#${f.docsChannel}`, {
    announcement: `https://coforge.example/w/acme/artifacts/${channelDocId}`,
  });
  expect(updated.announcement).toMatchObject({
    artifactId: channelDocId,
    title: "Agent Pinned Guide",
    version: 1,
  });

  const info = await management.info(f.workspaceId, f.agents.reader, `#${f.docsChannel}`);
  expect(info.announcement).toMatchObject({
    artifactId: channelDocId,
    title: "Agent Pinned Guide",
    version: 1,
  });

  const roster = await listAgentWorkspaceChannels(
    f.db,
    f.workspaceId,
    { agentId: f.agents.reader },
    "member",
  );
  const docsRow = roster.find((row) => row.name === `#${f.docsChannel}`);
  expect(docsRow?.announcement).toMatchObject({
    artifactId: channelDocId,
    title: "Agent Pinned Guide",
    version: 1,
  });

  await expect(
    management.update(f.workspaceId, f.agents.reader, `#${f.docsChannel}`, {
      announcement: channelDocId,
    }),
  ).rejects.toMatchObject({ status: 403 });

  const invalidRefRes = await handleAgentChannelPatch(
    new Request(`http://local/api/agent/v1/channels/%23${f.docsChannel}`, {
      method: "PATCH",
      body: JSON.stringify({ idempotencyKey: f.key(), announcement: "Bare Title Only" }),
    }),
    `#${f.docsChannel}`,
    { workspaceId: f.workspaceId, agentId: f.agents.writer },
    management,
  );
  expect(invalidRefRes.status).toBe(400);
  expect(await invalidRefRes.json()).toMatchObject({
    ok: false,
    errorCode: "channel_announcement_ref_invalid",
  });

  const foreignRes = await handleAgentChannelPatch(
    new Request(`http://local/api/agent/v1/channels/%23${f.docsChannel}`, {
      method: "PATCH",
      body: JSON.stringify({ idempotencyKey: f.key(), announcement: foreignDocId }),
    }),
    `#${f.docsChannel}`,
    { workspaceId: f.workspaceId, agentId: f.agents.writer },
    management,
  );
  expect(foreignRes.status).toBe(404);
  expect(await foreignRes.json()).toMatchObject({
    ok: false,
    errorCode: "pinned_artifact_not_in_conversation",
  });

  const cleared = await management.update(f.workspaceId, f.agents.writer, `#${f.docsChannel}`, {
    announcement: null,
  });
  expect(cleared.announcement).toBeNull();

  const aliceUser = await f.db.user.findUniqueOrThrow({
    where: { id: f.alice },
    select: { username: true },
  });
  const dmDocId = await f.make("DM Runbook", undefined, {
    target: `@${aliceUser.username}`,
    by: f.agents.writer,
  });

  const dmPinned = await management.update(
    f.workspaceId,
    f.agents.writer,
    `dm:@${aliceUser.username}`,
    { announcement: dmDocId },
  );
  expect(dmPinned.announcement).toMatchObject({
    artifactId: dmDocId,
    title: "DM Runbook",
    version: 1,
  });

  await expect(
    management.update(f.workspaceId, f.agents.writer, `@${aliceUser.username}`, {
      name: "nope",
    }),
  ).rejects.toBeInstanceOf(AgentChannelManagementError);

  const dmPush = await f.post(f.agents.writer, {
    operation: "push",
    idempotencyKey: f.key(),
    artifact: dmDocId,
    baseVersion: 1,
    note: "DM pinned artifacts stay pushable by participants",
    files: await f.manifestOf(f.agents.writer, { "plan.md": "# DM Runbook v2\n" }),
  });
  expect(dmPush.status).toBe(200);

  const dmCleared = await management.update(
    f.workspaceId,
    f.agents.writer,
    `@${aliceUser.username}`,
    { announcement: null },
  );
  expect(dmCleared.announcement).toBeNull();

  await expect(
    management.update(f.workspaceId, f.agents.writer, `#${f.docsChannel}`, {
      description: "Should not persist when announcement is foreign",
      announcement: foreignDocId,
    }),
  ).rejects.toMatchObject({ status: 404, errorCode: "pinned_artifact_not_in_conversation" });
  const untouched = await management.info(f.workspaceId, f.agents.writer, `#${f.docsChannel}`);
  expect(untouched.description).not.toBe("Should not persist when announcement is foreign");

  const shadowPrivateAgent = await f.db.agent.create({
    data: {
      workspaceId: f.workspaceId,
      name: aliceUser.username,
      displayName: "Bob Private Shadow",
      ownerId: f.bob,
      visibility: "private",
      runtimeConfig: {},
    },
    select: { id: true },
  });
  try {
    const nonLeakingDmPin = await management.update(
      f.workspaceId,
      f.agents.writer,
      `@${aliceUser.username}`,
      { announcement: dmDocId },
    );
    expect(nonLeakingDmPin.announcement?.artifactId).toBe(dmDocId);
  } finally {
    await f.db.agent.delete({ where: { id: shadowPrivateAgent.id } });
  }

  await management.update(f.workspaceId, f.agents.writer, `#${f.docsChannel}`, {
    announcement: channelDocId,
  });
  await f.db.conversation.update({
    where: { id: docsChannelId },
    data: { archivedAt: new Date() },
  });
  try {
    const archivedAdminPush = await f.post(f.agents.writer, {
      operation: "push",
      idempotencyKey: f.key(),
      artifact: channelDocId,
      baseVersion: 1,
      note: "Push while channel is archived",
      files: await f.manifestOf(f.agents.writer, { "plan.md": "# Archived push\n" }),
    });
    expect(archivedAdminPush.status).toBe(403);
    expect(archivedAdminPush.body.error).toContain("channel-announcement-push-forbidden");
    expect(archivedAdminPush.body.details).toMatchObject({
      channel: `#${f.docsChannel}`,
      reason: "archived",
    });
  } finally {
    await f.db.conversation.update({
      where: { id: docsChannelId },
      data: { archivedAt: null },
    });
  }
});

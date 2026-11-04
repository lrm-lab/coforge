import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { RedisClient } from "bun";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { handleAgentMessagesPost } from "#src/routes/api/agent/v1/messages";
import { handleAgentAttachmentUpload } from "#src/routes/api/agent/v1/attachments/index";
import { handleAttachmentUploadSessionCreate } from "#src/routes/api/agent/v1/attachment-upload-sessions/index";
import { handleAgentActionPrepare } from "#src/routes/api/agent/v1/actions/prepare";
import { ActionCards } from "#src/server/conversations/action-cards.server";
import { teardown } from "./helpers/workspace-teardown";
import {
  agentMessageDependencies,
  channelTestConnectionString as connectionString,
  channelTestRedisUrl as redisUrl,
  memberLeaveSetup as setup,
  type Person,
} from "./helpers/workspace-member-leave-fixture";

/**
 * The Agent side of a Workspace member leaving: recovery, refused sends and uploads, replays and
 * the direct conversation a missing member row re-opens. Drives the real services and Prisma
 * stores against local PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL; the send/upload tests
 * also need `CHANNEL_TEST_REDIS_URL` for request records.
 */

const createAgent = (db: PrismaClient, workspaceId: string, owner: Person) =>
  db.agent.create({
    data: {
      workspaceId,
      ownerId: owner.id,
      name: `helper-${owner.username}`,
      displayName: "Helper",
      runtimeConfig: {},
    },
  });

/** Bob's own Agent, with one direct message from Bob it has not read yet. */
async function unreadAgentDirectMessage(db: PrismaClient, workspaceId: string, bob: Person) {
  const helper = await createAgent(db, workspaceId, bob);
  const repo = new PrismaDirectConversationRepository(db);
  const opened = await repo.memberForUser(workspaceId, bob.id, helper.id);
  const sent = await repo.sendMessage(
    opened.conversationId,
    opened.senderMemberId,
    bob.id,
    "please look",
  );
  return { repo, helper, conversationId: opened.conversationId, sent };
}

test.skipIf(!connectionString)(
  "an Agent still recovers, reads and marks read a direct message from someone who left",
  async () => {
    const { db, directory, workspace, owner, bob } = await setup();
    try {
      const { repo, helper, sent } = await unreadAgentDirectMessage(db, workspace.id, bob);

      await directory.leave({ workspaceId: workspace.id, userId: bob.id });

      const recovery = await repo.readAgentRecoveryContext(workspace.id, helper.id);
      expect(recovery.unreadSummary).toEqual({ [`@${bob.username}`]: 1 });
      await repo.advanceAgentReadThrough(
        workspace.id,
        helper.id,
        `@${bob.username}`,
        sent.sequence,
      );
      expect((await repo.readAgentRecoveryContext(workspace.id, helper.id)).unreadSummary).toEqual(
        {},
      );
    } finally {
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);

const departedRefusal = (bob: Person) => ({
  code: "DM_PEER_NOT_IN_WORKSPACE",
  error: `@${bob.username} is not a member of this Workspace, so this Agent cannot send them a direct message`,
  retryable: false,
});

test.skipIf(!connectionString || !redisUrl)(
  "an Agent's reply to someone who left is refused with a stable code, and nothing is written",
  async () => {
    const { db, directory, workspace, owner, bob } = await setup();
    const redis = new RedisClient(redisUrl!);
    try {
      const { repo, helper, conversationId, sent } = await unreadAgentDirectMessage(
        db,
        workspace.id,
        bob,
      );
      const agentBoundary = () =>
        db.conversationMember.findFirstOrThrow({
          where: { conversationId, agentId: helper.id },
          select: { agentReadThroughSequence: true },
        });
      const boundaryBefore = await agentBoundary();

      await directory.leave({ workspaceId: workspace.id, userId: bob.id });

      const records = new RedisMessageRequestIdempotency(redis);
      const dependencies = agentMessageDependencies(repo, records);
      const send = {
        target: `@${bob.username}`,
        content: "on it",
      };
      // Having reviewed the unread message, with it still unread, and sending anyway: none of
      // them advances the Agent's read position, holds the send, or records the request.
      for (const extra of [{ seenUpToSeq: sent.sequence }, {}, { continueAnyway: true }]) {
        const idempotencyKey = crypto.randomUUID();
        const response = await handleAgentMessagesPost(
          new Request("https://server.example/api/agent/v1/messages", {
            method: "POST",
            body: JSON.stringify({ ...send, ...extra, idempotencyKey }),
          }),
          { workspaceId: workspace.id, agentId: helper.id },
          dependencies,
        );
        expect({ status: response.status, body: await response.json() }).toEqual({
          status: 403,
          body: departedRefusal(bob),
        });
        expect(
          await records.find({
            workspaceId: workspace.id,
            senderKind: "agent",
            senderId: helper.id,
            idempotencyKey: idempotencyKey,
          }),
        ).toBeUndefined();
      }
      expect(await db.message.count({ where: { conversationId } })).toBe(1);
      expect(await agentBoundary()).toEqual(boundaryBefore);
    } finally {
      redis.close();
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "an Agent cannot upload an attachment to someone who left",
  async () => {
    const { db, directory, workspace, owner, bob } = await setup();
    try {
      const { repo, helper } = await unreadAgentDirectMessage(db, workspace.id, bob);
      await directory.leave({ workspaceId: workspace.id, userId: bob.id });
      const principal = { workspaceId: workspace.id, agentId: helper.id };
      const resolveTarget = repo.resolveAgentSendTarget.bind(repo);
      let stored = 0;

      const form = new FormData();
      form.set("target", `@${bob.username}`);
      form.set("file", new File(["notes"], "notes.txt", { type: "text/plain" }));
      const upload = await handleAgentAttachmentUpload(
        new Request("https://server.example/api/agent/v1/attachments", {
          method: "POST",
          body: form,
        }),
        principal,
        {
          resolveTarget,
          store: async () => {
            stored += 1;
            throw new Error("nothing is stored for a refused target");
          },
        },
      );
      const session = await handleAttachmentUploadSessionCreate(
        new Request("https://server.example/api/agent/v1/attachment-upload-sessions", {
          method: "POST",
          body: JSON.stringify({
            target: `@${bob.username}`,
            fileName: "notes.txt",
            contentType: "text/plain",
            sizeBytes: 5,
            idempotencyKey: crypto.randomUUID(),
          }),
        }),
        principal,
        {
          resolveTarget,
          create: async () => {
            stored += 1;
            throw new Error("nothing is stored for a refused target");
          },
        },
      );

      for (const response of [upload, session])
        expect({ status: response.status, body: await response.json() }).toEqual({
          status: 403,
          body: departedRefusal(bob),
        });
      expect(stored).toBe(0);
    } finally {
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);

test.skipIf(!connectionString || !redisUrl)(
  "a replay of an Agent's committed reply still reports it sent after the person left",
  async () => {
    const { db, directory, workspace, owner, bob } = await setup();
    const redis = new RedisClient(redisUrl!);
    try {
      const { repo, helper, conversationId } = await unreadAgentDirectMessage(
        db,
        workspace.id,
        bob,
      );
      const records = new RedisMessageRequestIdempotency(redis);
      const dependencies = agentMessageDependencies(repo, records);
      const idempotencyKey = crypto.randomUUID();
      const send = () =>
        handleAgentMessagesPost(
          new Request("https://server.example/api/agent/v1/messages", {
            method: "POST",
            body: JSON.stringify({
              target: `@${bob.username}`,
              content: "on it",
              idempotencyKey,
              continueAnyway: true,
            }),
          }),
          { workspaceId: workspace.id, agentId: helper.id },
          dependencies,
        ).then(async (response) => ({ status: response.status, body: await response.json() }));
      const messageCount = () => db.message.count({ where: { conversationId } });

      // The first send commits; its answer is lost, and the person leaves before the retry.
      const first = await send();
      expect(first).toMatchObject({ status: 200, body: { state: "sent" } });
      const committed = await messageCount();
      await directory.leave({ workspaceId: workspace.id, userId: bob.id });

      const replay = await send();
      expect(replay).toMatchObject({
        status: 200,
        body: {
          state: "sent",
          messageId: first.body.messageId,
          pendingMentionActions: first.body.pendingMentionActions,
          unresolvedMentionHandles: first.body.unresolvedMentionHandles,
        },
      });
      expect(await messageCount()).toBe(committed);
    } finally {
      redis.close();
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);

test.skipIf(!connectionString || !redisUrl)(
  "a replay of an Agent's committed channel message reports the same mentions it did not reach",
  async () => {
    const { db, channels, workspace, owner, bob } = await setup();
    const redis = new RedisClient(redisUrl!);
    try {
      const helper = await createAgent(db, workspace.id, bob);
      const other = await createAgent(db, workspace.id, owner);
      const channelName = `ops-${helper.id.slice(0, 8)}`;
      const ops = await channels.create(workspace.id, owner.id, channelName);
      await channels.addMembers(workspace.id, { userId: owner.id }, ops.id, {
        userIds: [],
        agentIds: [helper.id, other.id],
      });
      const repo = new PrismaDirectConversationRepository(db);
      const records = new RedisMessageRequestIdempotency(redis);
      const dependencies = agentMessageDependencies(repo, records);
      const idempotencyKey = crypto.randomUUID();
      const ghost = `ghost-${helper.id.slice(0, 8)}`;
      // Bob is in the Workspace but not in the channel; the ghost is nobody.
      const send = () =>
        handleAgentMessagesPost(
          new Request("https://server.example/api/agent/v1/messages", {
            method: "POST",
            body: JSON.stringify({
              target: `#${channelName}`,
              content: `@${bob.username} @${ghost} please look`,
              idempotencyKey,
              continueAnyway: true,
            }),
          }),
          { workspaceId: workspace.id, agentId: helper.id },
          dependencies,
        ).then(async (response) => ({ status: response.status, body: await response.json() }));

      const first = await send();
      expect(first).toMatchObject({ status: 200, body: { state: "sent" } });
      expect(first.body.pendingMentionActions).toMatchObject([{ targetHandle: bob.username }]);
      expect(first.body.unresolvedMentionHandles).toEqual([ghost]);

      const replay = await send();
      expect(replay).toMatchObject({
        status: 200,
        body: {
          state: "sent",
          reason: "already_committed",
          messageId: first.body.messageId,
          pendingMentionActions: first.body.pendingMentionActions,
          unresolvedMentionHandles: first.body.unresolvedMentionHandles,
        },
      });
      // Another Agent in the same channel never reads this Agent's report for the message.
      expect(
        await repo.committedAgentMentionReport(workspace.id, other.id, first.body.messageId),
      ).toEqual({ pendingMentionActions: [], unresolvedMentionHandles: [] });
    } finally {
      redis.close();
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);

/** A route's answer, or what it threw past the handler (which the Agent middleware turns into 401). */
async function outcome(respond: () => Promise<Response>) {
  try {
    const response = await respond();
    return { status: response.status, body: await response.json() };
  } catch (error) {
    return { thrown: error instanceof Error ? error.message : String(error) };
  }
}

test.skipIf(!connectionString || !redisUrl)(
  "an Agent's send, upload or action card to someone outside the Workspace reads exactly like an unknown username",
  async () => {
    const { db, workspace, owner, bob } = await setup();
    const redis = new RedisClient(redisUrl!);
    const elsewhere = await db.user.create({
      data: {
        displayName: `ml-elsewhere-${crypto.randomUUID().slice(0, 8)}`,
        username: `ml-elsewhere-${crypto.randomUUID().slice(0, 8)}`,
      },
    });
    const otherWorkspace = await db.workspace.create({
      data: {
        slug: `ml-other-${crypto.randomUUID().slice(0, 8)}`,
        name: "Elsewhere",
        members: { create: { userId: elsewhere.id, role: "owner" } },
      },
    });
    try {
      const helper = await createAgent(db, workspace.id, bob);
      const repo = new PrismaDirectConversationRepository(db);
      const records = new RedisMessageRequestIdempotency(redis);
      const principal = { workspaceId: workspace.id, agentId: helper.id };
      const resolveTarget = repo.resolveAgentSendTarget.bind(repo);
      const refuseStore = async (): Promise<never> => {
        throw new Error("nothing is stored for a refused target");
      };
      const answers = async (target: string) => {
        const form = new FormData();
        form.set("target", target);
        form.set("file", new File(["notes"], "notes.txt", { type: "text/plain" }));
        return {
          send: await outcome(() =>
            handleAgentMessagesPost(
              new Request("https://server.example/api/agent/v1/messages", {
                method: "POST",
                body: JSON.stringify({
                  target,
                  content: "hi",
                  idempotencyKey: crypto.randomUUID(),
                }),
              }),
              principal,
              agentMessageDependencies(repo, records),
            ),
          ),
          upload: await outcome(() =>
            handleAgentAttachmentUpload(
              new Request("https://server.example/api/agent/v1/attachments", {
                method: "POST",
                body: form,
              }),
              principal,
              { resolveTarget, store: refuseStore },
            ),
          ),
          session: await outcome(() =>
            handleAttachmentUploadSessionCreate(
              new Request("https://server.example/api/agent/v1/attachment-upload-sessions", {
                method: "POST",
                body: JSON.stringify({
                  target,
                  fileName: "notes.txt",
                  contentType: "text/plain",
                  sizeBytes: 5,
                  idempotencyKey: crypto.randomUUID(),
                }),
              }),
              principal,
              { resolveTarget, create: refuseStore },
            ),
          ),
          prepare: await outcome(() =>
            handleAgentActionPrepare(
              new Request("https://server.example/api/agent/v1/actions/prepare", {
                method: "POST",
                body: JSON.stringify({
                  target,
                  action: { type: "channel:create", name: "ops", visibility: "public" },
                }),
              }),
              principal,
              () => new ActionCards(db, repo),
            ),
          ),
        };
      };

      const unknown = await answers(`@ml-nobody-${crypto.randomUUID().slice(0, 8)}`);
      expect(await answers(`@${elsewhere.username}`)).toEqual(unknown);
      expect(unknown.send).toEqual({
        status: 403,
        body: {
          error: "target is not accessible",
          code: "TARGET_NOT_ACCESSIBLE",
          retryable: false,
        },
      });
      expect(unknown.upload).toEqual(unknown.send);
      expect(unknown.session).toEqual(unknown.send);
      expect(unknown.prepare).toEqual(unknown.send);
    } finally {
      redis.close();
      await db.workspace.delete({ where: { id: otherWorkspace.id } }).catch(() => {});
      await db.user.delete({ where: { id: elsewhere.id } }).catch(() => {});
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "an Agent's action card to someone who left is refused with the same code",
  async () => {
    const { db, directory, workspace, owner, bob } = await setup();
    try {
      const { repo, helper } = await unreadAgentDirectMessage(db, workspace.id, bob);
      await directory.leave({ workspaceId: workspace.id, userId: bob.id });

      const response = await handleAgentActionPrepare(
        new Request("https://server.example/api/agent/v1/actions/prepare", {
          method: "POST",
          body: JSON.stringify({
            target: `@${bob.username}`,
            action: { type: "channel:create", name: `ops-${bob.username}` },
          }),
        }),
        { workspaceId: workspace.id, agentId: helper.id },
        () => new ActionCards(db, repo),
      );
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 403,
        body: departedRefusal(bob),
      });
    } finally {
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "a direct message with an Agent that lost its member row works again when the person opens it",
  async () => {
    const { db, workspace, owner, bob } = await setup();
    try {
      const helper = await createAgent(db, workspace.id, bob);
      const repo = new PrismaDirectConversationRepository(db);
      const { conversationId } = await repo.memberForUser(workspace.id, bob.id, helper.id);
      await repo.sendAgentMessage(conversationId, helper.id, "hello");
      // A row that owns no message could be deleted outright, and nothing else recreates it.
      await db.conversationMember.deleteMany({ where: { conversationId, userId: bob.id } });

      const direct = new DirectConversations(db);
      expect(await direct.open(workspace.id, bob.id, { agentId: helper.id })).toEqual({
        conversationId,
      });
      const page = await direct.page(workspace.id, bob.id, conversationId);
      expect(page.messages.map((message) => message.body)).toEqual(["hello"]);
    } finally {
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);

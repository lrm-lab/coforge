import { agentAttachmentMessagesFixture } from "./helpers/agent-attachment-messages-fixture";
import { WorkspaceAssistants } from "#src/server/agents/workspace-assistants.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { handleAgentMessagesGet, handleAgentMessagesPost } from "#src/routes/api/agent/v1/messages";
import { expect, test } from "bun:test";
import { getMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";

test("attachment messages read roots and a comment's thread, and refuse to reply", async () => {
  const f = await agentAttachmentMessagesFixture();
  try {
    expect((await f.messages.read(f.principal, f.target, {})).messages).toEqual([]);
    expect(
      await f.db.attachmentCommentThread.count({ where: { attachmentId: f.attachment.id } }),
    ).toBe(0);
    const root = await f.comments.post(f.actor, {
      attachmentId: f.attachment.id,
      body: "review this",
    });
    const page = await f.messages.read(f.principal, f.target, {});
    expect(page.messages.map((m) => [m.id, m.target, m.body])).toEqual([
      [root.id, f.target, "review this"],
    ]);
    // The Web discussion replies; the Agent can still read that comment's thread by its target.
    const webReply = await f.comments.post(f.actor, {
      attachmentId: f.attachment.id,
      rootId: root.id,
      body: "answered on the Web",
    });
    const replyTarget = `${f.target}:${root.id}`;
    const read = await f.messages.read(f.principal, replyTarget, {});
    expect(read.messages.map((m) => [m.id, m.target])).toEqual([[webReply.id, replyTarget]]);
    // Replying is refused: the Web comment panel shows top-level comments only, so a reply an
    // Agent sent would be invisible there.
    await expect(
      f.messages.executeFromAgent({
        ...f.principal,
        target: replyTarget,
        body: "reviewed",
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(
      (await f.comments.list(f.actor, { attachmentId: f.attachment.id })).comments.map((m) => m.id),
    ).toEqual([root.id]);
  } finally {
    await f.close();
  }
});

test("attachment authority survives no source membership loss, but committed sends replay", async () => {
  const f = await agentAttachmentMessagesFixture();
  try {
    const input = {
      ...f.principal,
      target: f.target,
      body: "once",
      idempotencyKey: crypto.randomUUID(),
    };
    const first = await f.messages.executeFromAgent(input);
    await f.db.conversationMember.update({
      where: {
        conversationId_agentId: { conversationId: f.conversation.id, agentId: f.principal.agentId },
      },
      data: { leftAt: new Date() },
    });
    await expect(f.messages.read(f.principal, f.target, {})).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      f.messages.executeFromAgent({ ...input, idempotencyKey: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await f.messages.executeFromAgent(input)).id).toBe(first.id);
    expect(await f.db.attachmentComment.count({ where: { attachmentId: f.attachment.id } })).toBe(
      1,
    );
  } finally {
    await f.close();
  }
});

test("short anchors stay scoped to this attachment's roots, and every reply is refused", async () => {
  const f = await agentAttachmentMessagesFixture();
  try {
    const root = await f.comments.post(f.actor, { attachmentId: f.attachment.id, body: "root" });
    const short = root.id.slice(0, 13);
    // A short anchor still selects this attachment's root for a read.
    expect((await f.messages.read(f.principal, `${f.target}:${short}`, {})).messages).toEqual([]);
    for (const anchor of [short, root.id, f.message.id]) {
      await expect(
        f.messages.executeFromAgent({
          ...f.principal,
          target: `${f.target}:${anchor}`,
          body: "scoped",
          idempotencyKey: crypto.randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    await expect(
      f.messages.read({ ...f.principal, workspaceId: crypto.randomUUID() }, f.target, {}),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      f.messages.executeFromAgent({
        ...f.principal,
        target: f.target,
        body: "upload",
        attachmentIds: [crypto.randomUUID()],
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  } finally {
    await f.close();
  }
});

test("the Agent HTTP message routes dispatch attachment targets and reconcile the same receipt", async () => {
  const f = await agentAttachmentMessagesFixture();
  try {
    const records = getMessageRequestIdempotency();
    const repository = {
      agentTargetFreshness: async () => {
        throw new Error("ordinary freshness must not handle comments");
      },
      setAgentChannelMuted: async () => {},
      setAgentThreadFollowed: async () => {},
      readMessagesPage: async () => {
        throw new Error("generic history must not handle comments");
      },
    };
    const dependencies = {
      repository,
      sender: {
        executeFromAgent: async () => {
          throw new Error("generic send must not handle comments");
        },
      },
      requestRecords: records,
      attachmentMessages: f.messages,
    };
    const request = (body: unknown) =>
      new Request("http://localhost/api/agent/v1/messages", {
        method: "POST",
        body: JSON.stringify(body),
      });
    const idempotencyKey = crypto.randomUUID();
    const sent = await handleAgentMessagesPost(
      request({
        target: f.target,
        content: "via HTTP",
        idempotencyKey,
        seenUpToSeq: 1,
        seenExactSeqs: [1],
      }),
      f.principal,
      dependencies,
    );
    expect(sent.status).toBe(200);
    const receipt = await sent.json();
    expect(receipt).toMatchObject({ state: "sent", idempotencyKey });
    const read = await handleAgentMessagesGet(
      new Request(`http://localhost/api/agent/v1/messages?target=${f.target}`),
      f.principal,
      repository,
      f.messages,
    );
    expect(read.status).toBe(200);
    expect((await read.json()).messages).toMatchObject([
      { id: receipt.messageId, body: "via HTTP", target: f.target },
    ]);
    const replay = await handleAgentMessagesPost(
      request({ target: f.target, reconcileOnly: true, idempotencyKey }),
      f.principal,
      dependencies,
    );
    expect(await replay.json()).toMatchObject({ state: "committed", messageId: receipt.messageId });
    await f.db.conversation.update({
      where: { id: f.conversation.id },
      data: { archivedAt: new Date() },
    });
    const refused = await handleAgentMessagesPost(
      request({ target: f.target, content: "new", idempotencyKey: crypto.randomUUID() }),
      f.principal,
      dependencies,
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "ACCESS_DENIED", retryable: false });
    const readable = await handleAgentMessagesGet(
      new Request(`http://localhost/api/agent/v1/messages?target=${f.target}`),
      f.principal,
      repository,
      f.messages,
    );
    expect(readable.status).toBe(200);
  } finally {
    await f.close();
  }
});

test("history windows keep root and reply cursors separate and never consume around reads", async () => {
  const f = await agentAttachmentMessagesFixture();
  try {
    const roots = [];
    for (const body of ["one", "two", "three"])
      roots.push(await f.comments.post(f.actor, { attachmentId: f.attachment.id, body }));
    const latest = await f.messages.read(f.principal, f.target, { limit: 2 });
    expect(latest.messages.map((m) => m.body)).toEqual(["two", "three"]);
    expect(latest).toMatchObject({
      hasOlder: true,
      hasNewer: false,
      modelSeenUpToSeq: null,
      unreadCursorBefore: 0,
    });
    const around = await f.messages.read(f.principal, f.target, { around: roots[1]!.id, limit: 1 });
    expect(around.messages.map((m) => m.body)).toEqual(["two"]);
    expect(around.modelSeenUpToSeq).toBeNull();
    const first = await f.messages.read(f.principal, f.target, { unread: true, limit: 2 });
    expect(first.messages.map((m) => m.body)).toEqual(["one", "two"]);
    expect(first).toMatchObject({
      unreadCursorBefore: 0,
      readPositionAfter: roots[1]!.sequence,
      moreUnread: true,
    });
    const next = await f.messages.read(f.principal, f.target, { unread: true, limit: 2 });
    expect(next.messages.map((m) => m.body)).toEqual(["three"]);
    await f.comments.post(f.actor, {
      attachmentId: f.attachment.id,
      body: "reply",
      rootId: roots[0]!.id,
    });
    const thread = await f.messages.read(f.principal, `${f.target}:${roots[0]!.id}`, {
      unread: true,
    });
    expect(thread.messages.map((m) => m.body)).toEqual(["reply"]);
    expect((await f.messages.read(f.principal, f.target, { unread: true })).messages).toEqual([]);
    await expect(
      f.messages.read(f.principal, f.target, { around: f.message.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  } finally {
    await f.close();
  }
});

test("discussion seats grant no generic read, resolve or search access, including after source revocation", async () => {
  const f = await agentAttachmentMessagesFixture();
  try {
    const sent = await f.messages.executeFromAgent({
      ...f.principal,
      target: f.target,
      body: "unfindable-secret",
      idempotencyKey: crypto.randomUUID(),
    });
    const row = await f.db.message.findUniqueOrThrow({ where: { id: sent.id } });
    const repo = new PrismaDirectConversationRepository(f.db);
    await expect(
      repo.readMessagesPage(f.workspace.id, f.principal.agentId, row.conversationId),
    ).rejects.toBeDefined();
    await expect(
      repo.resolveAgentMessage(f.workspace.id, f.principal.agentId, sent.id),
    ).rejects.toBeDefined();
    expect(
      (
        await repo.searchMessages(f.workspace.id, f.principal.agentId, {
          query: "unfindable-secret",
        })
      ).messages,
    ).toEqual([]);
    await f.db.conversation.update({
      where: { id: f.conversation.id },
      data: { hiddenFromWorkspaceAt: new Date() },
    });
    await expect(f.messages.read(f.principal, f.target, {})).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  } finally {
    await f.close();
  }
});

test("a platform assistant uses only its bound human's source permissions and private Agent cursor", async () => {
  const f = await agentAttachmentMessagesFixture();
  try {
    const assistant = await new WorkspaceAssistants(f.db).ensure(f.workspace.id, f.owner.id);
    const principal = { workspaceId: f.workspace.id, agentId: assistant.agentId };
    const sent = await f.messages.executeFromAgent({
      ...principal,
      target: f.target,
      body: "delegated",
      idempotencyKey: crypto.randomUUID(),
    });
    const page = await f.comments.list(f.actor, { attachmentId: f.attachment.id });
    expect(page.comments[0]).toMatchObject({ id: sent.id, senderKind: "user" });
    await f.messages.read(principal, f.target, { unread: true });
    const stored = await f.db.message.findUniqueOrThrow({ where: { id: sent.id } });
    const member = await f.db.conversationMember.findUniqueOrThrow({
      where: {
        conversationId_userId: { conversationId: stored.conversationId, userId: f.owner.id },
      },
    });
    expect(member.agentReadThroughSequence).toBe(0);
    await f.db.conversation.update({
      where: { id: f.conversation.id },
      data: { kind: "app_events" },
    });
    await expect(
      f.messages.executeFromAgent({
        ...principal,
        target: f.target,
        body: "readonly",
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await f.db.workspaceMembership.delete({
      where: { workspaceId_userId: { workspaceId: f.workspace.id, userId: f.owner.id } },
    });
    await expect(f.messages.read(principal, f.target, {})).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
  } finally {
    await f.close();
  }
});

test("ambiguous root prefixes and another attachment's root never select a comment", async () => {
  const f = await agentAttachmentMessagesFixture();
  try {
    const first = await f.comments.post(f.actor, { attachmentId: f.attachment.id, body: "first" });
    const second = await f.comments.post(f.actor, {
      attachmentId: f.attachment.id,
      body: "second",
    });
    // Force a prefix collision on existing rows without depending on UUID clock timing.
    const collided = first.id.slice(0, 8) + second.id.slice(8);
    await f.db.message.update({ where: { id: second.id }, data: { id: collided } });
    await expect(
      f.messages.read(f.principal, `${f.target}:${first.id.slice(0, 8)}`, {}),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const other = await f.db.attachment.create({
      data: {
        workspaceId: f.workspace.id,
        conversationId: f.conversation.id,
        messageId: f.message.id,
        uploaderId: f.owner.id,
        fileName: "other.txt",
        contentType: "text/plain",
        sizeBytes: 1,
        objectKey: crypto.randomUUID(),
      },
    });
    const foreign = await f.comments.post(f.actor, { attachmentId: other.id, body: "foreign" });
    await expect(
      f.messages.read(f.principal, `${f.target}:${foreign.id}`, {}),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(f.messages.read(f.principal, "attachment:12345678", {})).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(
      f.messages.executeFromAgent({
        ...f.principal,
        target: f.target,
        body: "@someone",
        mentions: [{ type: "agent", id: f.principal.agentId, name: "someone" }],
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", errorId: "attachment-message-text-only" });
  } finally {
    await f.close();
  }
});

test("concurrent same-key attachment sends persist at most one canonical Message", async () => {
  const f = await agentAttachmentMessagesFixture();
  try {
    const input = {
      ...f.principal,
      target: f.target,
      body: "once",
      idempotencyKey: crypto.randomUUID(),
    };
    const results = await Promise.allSettled([
      f.messages.executeFromAgent(input),
      f.messages.executeFromAgent(input),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    for (const result of results)
      if (result.status === "rejected")
        expect(result.reason.name).toBe("MessageRequestInProgressError");
    const replay = await f.messages.executeFromAgent(input);
    expect(
      await f.db.message.count({ where: { attachmentComment: { attachmentId: f.attachment.id } } }),
    ).toBe(1);
    expect(
      (await f.comments.list(f.actor, { attachmentId: f.attachment.id })).comments[0]!.id,
    ).toBe(replay.id);
  } finally {
    await f.close();
  }
});

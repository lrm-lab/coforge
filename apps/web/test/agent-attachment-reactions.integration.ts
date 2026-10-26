import { agentMessageReactionRepository } from "#src/server/agents/agent-message-reactions.server";
import { expect, test } from "bun:test";
import { handleAgentMessageReaction } from "#src/routes/api/agent/v1/messages_.$messageId.reactions";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { agentAttachmentMessagesFixture } from "./helpers/agent-attachment-messages-fixture";

test("Agent HTTP adds and removes a comment checkmark visible to the human Web discussion", async () => {
  const f = await agentAttachmentMessagesFixture();
  try {
    const comment = await f.comments.post(f.actor, {
      attachmentId: f.attachment.id,
      body: "Review this comment",
    });
    const repository = agentMessageReactionRepository(
      f.db,
      new PrismaDirectConversationRepository(f.db),
    );
    const react = (active: boolean) =>
      handleAgentMessageReaction(
        new Request("http://localhost/reactions", {
          method: active ? "POST" : "DELETE",
          body: JSON.stringify({ emoji: "✅", idempotencyKey: crypto.randomUUID() }),
        }),
        comment.id,
        active,
        f.principal,
        repository,
      );
    let version = 0;
    for (const active of [true, true, false, false]) {
      const response = await react(active);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ messageId: comment.id, emoji: "✅", active });
      const human = await f.comments.list(f.actor, { attachmentId: f.attachment.id });
      expect(human.comments[0]!.resolved).toBe(active);
      expect(human.comments[0]!.reactionVersion).toBe(++version);
      expect(human.comments[0]!.reactions ?? []).toMatchObject(
        active ? [{ emoji: "✅", count: 1 }] : [],
      );
    }
    expect(await f.db.agentMessageDelivery.count({ where: { messageId: comment.id } })).toBe(0);
  } finally {
    await f.close();
  }
});

test("serialized attachment capabilities give read-only users no resolve action", async () => {
  const { readAgentAttachmentComments } =
    await import("#src/server/attachments/agent-attachment-comments.server");
  const { handleAgentAttachmentCommentsGet } =
    await import("#src/routes/api/agent/v1/attachments/$attachmentId.comments");
  const { WorkspaceAssistants } = await import("#src/server/agents/workspace-assistants.server");
  const f = await agentAttachmentMessagesFixture();
  try {
    const page = async (principal = f.principal) => {
      const response = await handleAgentAttachmentCommentsGet(
        new Request("http://localhost/comments"),
        f.attachment.id,
        (request) => readAgentAttachmentComments(f.db, principal, request),
      );
      expect(response.status).toBe(200);
      return response.json();
    };
    expect((await page()).viewer).toEqual({
      canComment: true,
      canResolve: true,
      resolveAction: { type: "reaction", emoji: "✅" },
    });
    const assistant = await new WorkspaceAssistants(f.db).ensure(f.workspace.id, f.viewer.id);
    expect(
      (await page({ workspaceId: f.workspace.id, agentId: assistant.agentId })).viewer,
    ).toEqual({
      canComment: false,
      canResolve: false,
      reason: "not-member",
    });
    for (const [data, reason] of [
      [{ archivedAt: new Date() }, "archived"],
      [{ archivedAt: null, kind: "app_events" }, "read-only"],
    ] as const) {
      await f.db.conversation.update({ where: { id: f.conversation.id }, data });
      expect((await page()).viewer).toEqual({ canComment: false, canResolve: false, reason });
    }
  } finally {
    await f.close();
  }
});

for (const restriction of [
  "owner-only",
  "left",
  "archived",
  "read-only",
  "hidden",
  "workspace",
  "deleted",
] as const) {
  test(`comment reaction refuses ${restriction} without treating a discussion seat as authority`, async () => {
    const f = await agentAttachmentMessagesFixture();
    try {
      const comment = await f.comments.post(f.actor, {
        attachmentId: f.attachment.id,
        body: "Private",
      });
      await f.messages.read(f.principal, f.target, {});
      if (restriction === "owner-only")
        await f.db.conversationMember.delete({
          where: {
            conversationId_agentId: {
              conversationId: f.conversation.id,
              agentId: f.principal.agentId,
            },
          },
        });
      if (restriction === "left")
        await f.db.conversationMember.update({
          where: {
            conversationId_agentId: {
              conversationId: f.conversation.id,
              agentId: f.principal.agentId,
            },
          },
          data: { leftAt: new Date() },
        });
      if (restriction === "archived")
        await f.db.conversation.update({
          where: { id: f.conversation.id },
          data: { archivedAt: new Date() },
        });
      if (restriction === "read-only")
        await f.db.conversation.update({
          where: { id: f.conversation.id },
          data: { kind: "app_events" },
        });
      if (restriction === "hidden")
        await f.db.conversation.update({
          where: { id: f.conversation.id },
          data: { hiddenFromWorkspaceAt: new Date() },
        });
      if (restriction === "deleted")
        await f.db.attachment.delete({ where: { id: f.attachment.id } });
      const principal =
        restriction === "workspace"
          ? { ...f.principal, workspaceId: crypto.randomUUID() }
          : f.principal;
      const repository = agentMessageReactionRepository(
        f.db,
        new PrismaDirectConversationRepository(f.db),
      );
      const response = await handleAgentMessageReaction(
        new Request("http://localhost/reactions", {
          method: "POST",
          body: JSON.stringify({ emoji: "✅" }),
        }),
        comment.id,
        true,
        principal,
        repository,
      );
      if (["archived", "read-only"].includes(restriction)) expect(response.status).toBe(403);
      else if (["owner-only", "left", "hidden"].includes(restriction))
        expect(response.status).toBe(404);
      else expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await f.db.messageReaction.count({ where: { messageId: comment.id } })).toBe(0);
    } finally {
      await f.close();
    }
  });
}

test("assistant reactions use the bound human, while short comment anchors remain ordinary-only", async () => {
  const { WorkspaceAssistants } = await import("#src/server/agents/workspace-assistants.server");
  const f = await agentAttachmentMessagesFixture();
  try {
    const root = await f.comments.post(f.actor, { attachmentId: f.attachment.id, body: "Root" });
    const reply = await f.comments.post(f.actor, {
      attachmentId: f.attachment.id,
      rootId: root.id,
      body: "Reply",
    });
    const repository = agentMessageReactionRepository(
      f.db,
      new PrismaDirectConversationRepository(f.db),
    );
    const react = (id: string, principal = f.principal, emoji = "✅") =>
      handleAgentMessageReaction(
        new Request("http://localhost/reactions", {
          method: "POST",
          body: JSON.stringify({ emoji }),
        }),
        id,
        true,
        principal,
        repository,
      );
    expect((await react(root.id.slice(0, 13))).status).toBe(400);
    expect((await react(f.message.id.slice(0, 13), f.principal, "👍")).status).toBe(200);
    expect((await react(root.id, f.principal, "bad emoji")).status).toBe(400);
    const owner = await new WorkspaceAssistants(f.db).ensure(f.workspace.id, f.owner.id);
    const viewer = await new WorkspaceAssistants(f.db).ensure(f.workspace.id, f.viewer.id);
    expect((await react(reply.id, { ...f.principal, agentId: owner.agentId })).status).toBe(200);
    expect((await react(root.id, { ...f.principal, agentId: viewer.agentId })).status).toBe(403);
    const stored = await f.db.messageReaction.findFirstOrThrow({
      where: { messageId: reply.id },
      include: { member: true },
    });
    expect(stored.member.userId).toBe(f.owner.id);
    expect(stored.member.agentId).toBeNull();
    expect(
      (await f.comments.list(f.actor, { attachmentId: f.attachment.id, rootId: root.id }))
        .comments[0]!.resolved,
    ).toBe(true);
    const canonical = await react(root.id.toUpperCase());
    expect(canonical.status).toBe(200);
    expect(await canonical.json()).toMatchObject({ messageId: root.id });
  } finally {
    await f.close();
  }
});

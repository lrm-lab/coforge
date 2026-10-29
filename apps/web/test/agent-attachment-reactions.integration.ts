import { agentMessageReactionRepository } from "#src/server/agents/agent-message-reactions.server";
import { expect, test } from "bun:test";
import { handleAgentMessageReaction } from "#src/routes/api/agent/v1/messages_.$messageId.reactions";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { agentAttachmentMessagesFixture } from "./helpers/agent-attachment-messages-fixture";

test("an Agent's comment reaction is refused, and the human Web discussion stays untouched", async () => {
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
    for (const active of [true, false]) {
      const response = await react(active);
      // The Web comment panel shows top-level comments only, so an Agent reaction has nowhere to
      // appear; it is refused with that reason rather than silently doing nothing.
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "attachment comments take no reactions; react to a message instead",
      });
      const human = await f.comments.list(f.actor, { attachmentId: f.attachment.id });
      expect(human.comments[0]!.resolved).toBe(false);
      expect(human.comments[0]!.reactions ?? []).toEqual([]);
    }
    expect(await f.db.messageReaction.count({ where: { messageId: comment.id } })).toBe(0);
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
  test(`comment reaction is refused under ${restriction}, never authorized by a discussion seat`, async () => {
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
      if (["workspace", "deleted"].includes(restriction)) {
        // The comment is not even visible to this principal, so it is not named as a comment.
        expect(response.status).toBeGreaterThanOrEqual(400);
      } else {
        // Refused before any authority is read: a comment reaction has no place to show, so no
        // restriction can make it succeed and no discussion seat can authorize one.
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: "attachment comments take no reactions; react to a message instead",
        });
      }
      expect(await f.db.messageReaction.count({ where: { messageId: comment.id } })).toBe(0);
    } finally {
      await f.close();
    }
  });
}

test("comment reactions stay refused for a bound assistant, while ordinary ones still work", async () => {
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
    // Short anchors, bad emoji, comments, replies, an uppercased id and an assistant bound to a
    // person: all refused, because the Web comment panel has nowhere to show a reaction.
    const owner = await new WorkspaceAssistants(f.db).ensure(f.workspace.id, f.owner.id);
    const viewer = await new WorkspaceAssistants(f.db).ensure(f.workspace.id, f.viewer.id);
    for (const response of [
      await react(root.id.slice(0, 13)),
      await react(root.id, f.principal, "bad emoji"),
      await react(reply.id, { ...f.principal, agentId: owner.agentId }),
      await react(root.id, { ...f.principal, agentId: viewer.agentId }),
      await react(root.id.toUpperCase()),
    ])
      expect(response.status).toBe(400);
    expect(await f.db.messageReaction.count({ where: { messageId: root.id } })).toBe(0);
    expect(await f.db.messageReaction.count({ where: { messageId: reply.id } })).toBe(0);
    // An ordinary message reaction is what an Agent may still do.
    expect((await react(f.message.id.slice(0, 13), f.principal, "👍")).status).toBe(200);
  } finally {
    await f.close();
  }
});

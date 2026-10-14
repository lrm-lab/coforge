import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { ChatSections } from "#src/server/conversations/chat-sections.server";
import { chatSectionFields, chatSectionPatch } from "./chat-section.schemas";

export const listChatSections = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(({ context: { db, workspaceId, user } }) =>
    new ChatSections(db, workspaceId, user.id).list(),
  );

export const createChatSection = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(chatSectionFields)
  .handler(({ context: { db, workspaceId, user }, data }) =>
    new ChatSections(db, workspaceId, user.id).create(data),
  );

export const updateChatSection = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ id: z.uuid(), patch: chatSectionPatch }))
  .handler(({ context: { db, workspaceId, user }, data }) =>
    new ChatSections(db, workspaceId, user.id).update(data.id, data.patch),
  );

export const deleteChatSection = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ id: z.uuid() }))
  .handler(({ context: { db, workspaceId, user }, data }) =>
    new ChatSections(db, workspaceId, user.id).remove(data.id),
  );

export const reorderChatSections = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ ids: z.array(z.uuid()).max(500) }))
  .handler(({ context: { db, workspaceId, user }, data }) =>
    new ChatSections(db, workspaceId, user.id).reorder(data.ids),
  );

export const moveConversationToSection = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      conversationId: z.uuid(),
      sectionId: z.uuid().nullable(),
      beforeConversationId: z.uuid().nullable().optional(),
    }),
  )
  .handler(({ context: { db, workspaceId, user }, data }) =>
    new ChatSections(db, workspaceId, user.id).move(
      data.conversationId,
      data.sectionId,
      data.beforeConversationId,
    ),
  );

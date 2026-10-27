import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { listConversationFiles } from "#src/server/conversations/conversation-files.server";

export type ConversationFile = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  imageWidth?: number;
  imageHeight?: number;
  createdAt: string;
  sender: string;
  /** True only for the raster types `/api/attachments/:id` serves inline — an SVG "image/*"
   * must render as the generic file icon, never as an `<img>` from the app origin. */
  inlineImage: boolean;
  /** A short-lived signed CDN URL for an inline-eligible image or an off-origin-frameable PDF
   * (same signing as message attachments); its absence means the client preview falls back to
   * the authenticated route, and a PDF stays download-only. */
  previewUrl?: string;
  /** The message this file was sent on, for locate-in-chat links; the hash anchor resolves a
   * thread reply through its root, orphaned files (message deleted) have none. */
  messageId: string | null;
};

/** Every file ever sent in one conversation, newest first, for the chat page's Files tab. */
export const loadConversationFiles = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ conversationId: z.uuid() }))
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    return listConversationFiles(db, {
      workspaceId,
      userId: user.id,
      conversationId: data.conversationId,
    });
  });

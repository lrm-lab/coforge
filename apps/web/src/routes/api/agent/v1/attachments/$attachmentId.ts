import { workspaceAssistantUser } from "#src/server/agents/workspace-assistant-authority.server";
import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { readAuthorizedAttachment } from "#src/server/attachments/attachment.server";
import { attachmentFailure } from "#src/routes/api/attachments.$attachmentId";
import { contentDispositionFileName } from "#src/server/attachments/attachment-response.server";

export const Route = createFileRoute("/api/agent/v1/attachments/$attachmentId")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: async ({ context: { principal, db }, params }) => {
        let read: Awaited<ReturnType<typeof readAuthorizedAttachment>>;
        try {
          const delegate = await workspaceAssistantUser(
            db,
            principal.workspaceId,
            principal.agentId,
          );
          read = await readAuthorizedAttachment(db, {
            attachmentId: params.attachmentId,
            workspaceId: principal.workspaceId,
            userId: delegate?.userId,
            agentId: principal.agentId,
          });
        } catch {
          return attachmentFailure("not_found", 404);
        }
        const { attachment } = read;
        // The row and the permission are proven; what is left is the stored object, and a failure
        // here names itself instead of reading as a missing attachment.
        let file: Awaited<ReturnType<typeof read.open>>;
        try {
          file = await read.open();
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "attachment_download_failed",
              reason: "storage_error",
              errorType: error instanceof Error ? error.name : typeof error,
            }),
          );
          return attachmentFailure("storage_error", 502);
        }
        if (!file) {
          console.error(
            JSON.stringify({ event: "attachment_download_failed", reason: "object_missing" }),
          );
          return attachmentFailure("object_missing", 502);
        }
        try {
          return new Response(file.body, {
            headers: {
              "Content-Type": attachment.contentType,
              "Content-Disposition": contentDispositionFileName("attachment", attachment.fileName),
            },
          });
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "attachment_download_failed",
              reason: "storage_error",
              errorType: error instanceof Error ? error.name : typeof error,
            }),
          );
          return attachmentFailure("storage_error", 502);
        }
      },
    },
  },
});

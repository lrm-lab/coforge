import { workspaceAssistantUser } from "#src/server/agents/workspace-assistant-authority.server";
import { textResponse } from "#src/server/http/text-response.server";
import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { readAuthorizedAttachment } from "#src/server/attachments/attachment.server";

export const Route = createFileRoute("/api/agent/v1/attachments/$attachmentId")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: async ({ context: { principal, db }, params }) => {
        try {
          const delegate = await workspaceAssistantUser(
            db,
            principal.workspaceId,
            principal.agentId,
          );
          const { attachment, open } = await readAuthorizedAttachment(db, {
            attachmentId: params.attachmentId,
            workspaceId: principal.workspaceId,
            userId: delegate?.userId,
            agentId: principal.agentId,
          });
          const file = await open();
          return new Response(file.body, {
            headers: {
              "Content-Type": attachment.contentType,
              "Content-Disposition": `attachment; filename="${attachment.fileName.replace(/["\\\r\n]/g, "_")}"`,
            },
          });
        } catch {
          return textResponse("not found", { status: 404 });
        }
      },
    },
  },
});

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { declareNoStore } from "#src/features/no-store-response.server";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { computerFileUploads } from "#src/server/computers/computer-file-upload-production.server";

const readInput = z.object({
  computerId: z.uuid(),
  uploadId: z.uuid(),
});

/**
 * The outcome of an upload started by `POST /api/computers/<id>/file-uploads`: pending while the
 * server stores the file and the Computer pulls it, then placed or failed. Only the Computer's
 * owner who started the upload reads it.
 */
export const readComputerFileUpload = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(readInput)
  .handler(async ({ data, context: { db, user, workspaceId } }) => {
    declareNoStore();
    const uploads = await computerFileUploads(db);
    return uploads.read({ userId: user.id, workspaceId }, data.computerId, data.uploadId);
  });

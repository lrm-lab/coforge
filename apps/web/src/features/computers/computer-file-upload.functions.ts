import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { MIME_TYPE_PATTERN } from "@lrm/coforge-sdk/internal";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { computerFileUploads } from "#src/server/computers/computer-file-upload-production.server";

const createInput = z.object({
  computerId: z.uuid(),
  fileName: z.string().min(1).max(255),
  contentType: z.string().regex(MIME_TYPE_PATTERN),
  sizeBytes: z.number().int().positive(),
});

const completeInput = z.object({
  computerId: z.uuid(),
  uploadId: z.uuid(),
});

/** Creates a short-lived presigned PUT for an owner upload destined for the Computer's uploads/. */
export const createComputerFileUpload = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(createInput)
  .handler(async ({ data, context: { db, user, workspaceId } }) => {
    setResponseHeader("cache-control", "no-store");
    const uploads = await computerFileUploads(db);
    return uploads.create(
      { userId: user.id, workspaceId },
      data.computerId,
      {
        fileName: data.fileName,
        contentType: data.contentType,
        sizeBytes: data.sizeBytes,
      },
    );
  });

/** Verifies the uploaded object and asks the Computer to pull it into uploads/. */
export const completeComputerFileUpload = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(completeInput)
  .handler(async ({ data, context: { db, user, workspaceId } }) => {
    setResponseHeader("cache-control", "no-store");
    const uploads = await computerFileUploads(db);
    return uploads.complete({ userId: user.id, workspaceId }, data.computerId, data.uploadId);
  });

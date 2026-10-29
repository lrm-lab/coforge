import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import type { PrismaClient } from "#src/generated/prisma/client";
import { optionalBrowserUser } from "#src/server/auth/require-user.server";
import { ATTACHMENT_MAX_BYTES, storeAttachment } from "#src/server/attachments/attachment.server";
import { isFile } from "#src/server/attachments/upload-file.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import { toPublicServerError } from "#src/server/errors/public-error.server";
import { AppError, isAppError, type AppErrorCode } from "#src/lib/app-error";

const attachmentUploadInputSchema = z.object({
  conversationId: z.string().min(1),
  file: z.custom<File>(isFile),
});

export const Route = createFileRoute("/api/attachments")({
  server: {
    handlers: {
      POST: ({ request }) => handleAttachmentUpload(request),
    },
  },
});

/**
 * Why an upload was refused, for the composer to say (task #291): `too_large` (past
 * `ATTACHMENT_MAX_BYTES`, 413) and `signed_out` (the session ended, 401) beside the `code` every
 * refusal carries (403 `ACCESS_DENIED`: not a member of the conversation any more). The browser
 * uploads with a script, which follows a redirect to the sign-in page as if it were the answer, so
 * a session that ended is a 401 here, not the redirect a page gets.
 */
export type AttachmentUploadRefusal = "too_large" | "signed_out";

type AttachmentUploadDependencies = {
  authenticate(
    cookieHeader: string | undefined,
  ): { id: string } | null | Promise<{ id: string } | null>;
  database(): PrismaClient | null | undefined;
  store: typeof storeAttachment;
};

const attachmentUploadDependencies: AttachmentUploadDependencies = {
  authenticate: optionalBrowserUser,
  database: getDatabaseClient,
  store: storeAttachment,
};

export async function handleAttachmentUpload(
  request: Request,
  dependencies: AttachmentUploadDependencies = attachmentUploadDependencies,
): Promise<Response> {
  try {
    const user = await dependencies.authenticate(request.headers.get("cookie") ?? undefined);
    if (!user) return refused(401, "signed_out");
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new AppError("INVALID_INPUT");
    }
    const conversationId = form.get("conversationId");
    const file = form.get("file");
    const input = attachmentUploadInputSchema.safeParse({
      conversationId,
      file,
    });
    if (!input.success) throw new AppError("INVALID_INPUT");
    if (input.data.file.size > ATTACHMENT_MAX_BYTES) return refused(413, "too_large");
    const db = dependencies.database();
    if (!db) throw new AppError("TEMPORARILY_UNAVAILABLE");
    return Response.json(
      await dependencies.store(db, {
        userId: user.id,
        conversationId: input.data.conversationId,
        file: input.data.file,
      }),
    );
  } catch (error) {
    const publicError = toPublicServerError(error);
    if (!isAppError(publicError)) throw publicError;
    return Response.json(
      { code: publicError.code, errorId: publicError.errorId },
      {
        status: statusForErrorCode(publicError.code),
        headers: { "cache-control": "no-store" },
      },
    );
  }
}

function refused(status: 401 | 413, reason: AttachmentUploadRefusal) {
  return Response.json({ reason }, { status, headers: { "cache-control": "no-store" } });
}

function statusForErrorCode(code: AppErrorCode): number {
  if (code === "INVALID_INPUT") return 400;
  if (code === "ACCESS_DENIED") return 403;
  if (code === "NOT_FOUND") return 404;
  if (code === "CONFLICT") return 409;
  if (code === "TEMPORARILY_UNAVAILABLE") return 503;
  return 500;
}

import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import type { PrismaClient } from "#src/generated/prisma/client";
import { COMPUTER_FILE_MAX_BYTES } from "@lrm/coforge-sdk/internal";
import { AppError, isAppError, type AppErrorCode } from "#src/lib/app-error";
import { isValidWorkspaceSlug } from "#src/features/workspaces/workspace-slug";
import { optionalBrowserUser } from "#src/server/auth/require-user.server";
import { isFile } from "#src/server/attachments/upload-file.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import { toPublicServerError } from "#src/server/errors/public-error.server";
import { computerFileUploads } from "#src/server/computers/computer-file-upload-production.server";
import type {
  ComputerFileUploadReason,
  ComputerFileUploadStart,
} from "#src/server/computers/computer-file-upload.server";
import { requireWorkspaceIdForRequest } from "#src/server/workspaces/selection.server";

const inputSchema = z.object({
  file: z.custom<File>(isFile),
  workspaceSlug: z.string().optional(),
});

export type ComputerFileUploadRefusal = ComputerFileUploadReason | "signed_out";

export const Route = createFileRoute("/api/computers/$computerId/file-uploads")({
  server: {
    handlers: {
      POST: ({ request, params }) => handleComputerFileUpload(request, params.computerId),
    },
  },
});

export type ComputerFileUploadRouteDependencies = {
  authenticate(
    cookieHeader: string | undefined,
  ): { id: string } | null | Promise<{ id: string } | null>;
  database(): PrismaClient | null | undefined;
  resolveWorkspace(
    db: PrismaClient,
    userId: string,
    workspaceSlug: string | undefined,
  ): Promise<string>;
  start(
    db: PrismaClient,
    viewer: { userId: string; workspaceId: string },
    computerId: string,
    file: File,
  ): Promise<ComputerFileUploadStart>;
};

const dependencies: ComputerFileUploadRouteDependencies = {
  authenticate: optionalBrowserUser,
  database: getDatabaseClient,
  resolveWorkspace: (db, userId, workspaceSlug) =>
    requireWorkspaceIdForRequest(
      db,
      userId,
      typeof workspaceSlug === "string" && isValidWorkspaceSlug(workspaceSlug)
        ? workspaceSlug
        : undefined,
    ),
  start: async (db, viewer, computerId, file) =>
    (await computerFileUploads(db)).start(viewer, computerId, file),
};

/**
 * Receives the file and answers with the upload id as soon as it is validated: storing it and the
 * Computer's pull take longer than production keeps a request open, so the outcome is read with
 * `readComputerFileUpload`.
 */
export async function handleComputerFileUpload(
  request: Request,
  computerId: string,
  deps: ComputerFileUploadRouteDependencies = dependencies,
): Promise<Response> {
  try {
    if (!z.uuid().safeParse(computerId).success) throw new AppError("INVALID_INPUT");
    const user = await deps.authenticate(request.headers.get("cookie") ?? undefined);
    if (!user) return refused(401, "signed_out");
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new AppError("INVALID_INPUT");
    }
    const parsed = inputSchema.safeParse({
      file: form.get("file"),
      workspaceSlug: form.get("workspaceSlug") || undefined,
    });
    if (!parsed.success) throw new AppError("INVALID_INPUT");
    if (parsed.data.file.size > COMPUTER_FILE_MAX_BYTES) return refused(413, "too_large");
    const db = deps.database();
    if (!db) throw new AppError("TEMPORARILY_UNAVAILABLE");
    const workspaceId = await deps.resolveWorkspace(db, user.id, parsed.data.workspaceSlug);
    const result = await deps.start(
      db,
      { userId: user.id, workspaceId },
      computerId,
      parsed.data.file,
    );
    if (result.status === "started") {
      return Response.json(result, { status: 202, headers: { "cache-control": "no-store" } });
    }
    if (result.status === "too_large") return refused(413, "too_large");
    if (result.status === "invalid_name") return refused(400, "invalid_name");
    if (result.status === "storage_unavailable") return refused(503, "storage_unavailable");
    if (result.status === "offline") return refused(503, "offline");
    if (result.status === "unsupported") return refused(503, "unsupported");
    return refused(404, "unavailable");
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

function refused(status: number, reason: ComputerFileUploadRefusal) {
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

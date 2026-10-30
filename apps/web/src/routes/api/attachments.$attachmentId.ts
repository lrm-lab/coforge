import { createFileRoute } from "@tanstack/react-router";
import type { PrismaClient } from "#src/generated/prisma/client";
import { requireBrowserUser } from "#src/server/auth/require-user.server";
import {
  attachmentResponse,
  isDeliveryInlinePreview,
  isInlineImage,
} from "#src/server/attachments/attachment-response.server";
import { readAuthorizedAttachment } from "#src/server/attachments/attachment.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import { getFileDelivery, type FileDelivery } from "#src/server/files/file-delivery.server";
import type { StoredFile } from "#src/server/files/file-storage.server";
import { PRIVATE_NO_STORE } from "#src/server/http/cache-control.server";

/** Why a download did not happen, as the page and the CLI show it. */
export type AttachmentFailureReason =
  | "not_found"
  | "object_missing"
  | "storage_error"
  | "persistence_unavailable";

export const Route = createFileRoute("/api/attachments/$attachmentId")({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        handleAttachmentDownload(request, params, attachmentDownloadDependencies),
    },
  },
});

type AttachmentDownloadDependencies = {
  authenticate(cookieHeader: string | undefined): { id: string } | Promise<{ id: string }>;
  database(): PrismaClient | null | undefined;
  read(
    db: PrismaClient,
    input: { attachmentId: string; userId: string },
  ): Promise<{
    attachment: { fileName: string; contentType: string; objectKey: string };
    /** Null when the stored object is gone: the row and the permission are fine, the file is not. */
    open(): Promise<StoredFile | null>;
  }>;
  delivery(): FileDelivery | null;
};

const attachmentDownloadDependencies: AttachmentDownloadDependencies = {
  authenticate: requireBrowserUser,
  database: getDatabaseClient,
  read: readAuthorizedAttachment,
  delivery: getFileDelivery,
};

/**
 * Serves one authorized attachment. Forced downloads (`?download`), content types that are
 * neither an inline image nor delivery-previewable, and deployments without a `FileDelivery` all
 * stream the bytes through the backend exactly as before. Eligible types redirect to a
 * short-lived signed CDN URL instead, so the bytes never round-trip through the backend at all.
 */
export async function handleAttachmentDownload(
  request: Request,
  params: { attachmentId: string },
  dependencies: AttachmentDownloadDependencies = attachmentDownloadDependencies,
): Promise<Response> {
  const user = await dependencies.authenticate(request.headers.get("cookie") ?? undefined);
  const db = dependencies.database();
  if (!db) return attachmentFailure("persistence_unavailable", 503);
  let read: Awaited<ReturnType<AttachmentDownloadDependencies["read"]>>;
  try {
    read = await dependencies.read(db, {
      attachmentId: params.attachmentId,
      userId: user.id,
    });
  } catch {
    // No such attachment and one this person may not read answer the same: neither says whether
    // the other exists.
    return attachmentFailure("not_found", 404);
  }
  const { attachment } = read;
  const forceDownload = new URL(request.url).searchParams.has("download");
  // A file that may only render off our own origin (a PDF, a video) is redirected to the signed
  // delivery URL as well; when there is no delivery to sign with, `signedRedirect` returns null and
  // the bytes stream below as an opaque download, exactly as before.
  const redirect =
    !forceDownload && (isInlineImage(attachment.contentType) || isDeliveryInlinePreview(attachment))
      ? signedRedirect(dependencies, attachment.objectKey)
      : null;
  if (redirect) return redirect;
  // The read above proved the row and the permission; what is left is the object itself, and a
  // download that fails here says which of the two it was instead of hiding both behind a 404.
  let file: StoredFile | null;
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
    return attachmentResponse(request, attachment, file, forceDownload);
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
}

/**
 * A download that did not happen, with a reason the page and the CLI can show without a server log:
 * `not_found` (no such attachment, or not yours), `object_missing` (the row is there, the stored
 * object is not), `storage_error` (storage could not be read). The body never carries a file name
 * or an object key.
 */
export function attachmentFailure(reason: AttachmentFailureReason, status: number): Response {
  return new Response(JSON.stringify({ error: reason }), {
    status,
    headers: { "Content-Type": "application/json", "cache-control": PRIVATE_NO_STORE },
  });
}

/** The CDN redirect for one inline image, or `null` when delivery is off or failing (the caller
 * then streams the bytes, so a misconfigured secret degrades instead of breaking downloads). */
function signedRedirect(dependencies: AttachmentDownloadDependencies, objectKey: string) {
  try {
    const delivery = dependencies.delivery();
    if (!delivery) return null;
    const { url } = delivery.signedUrl(objectKey);
    return new Response(null, {
      status: 302,
      headers: {
        Location: url,
        "cache-control": PRIVATE_NO_STORE,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return null;
  }
}

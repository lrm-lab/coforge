import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError, isAppError } from "#src/lib/app-error";
import { optionalBrowserUser } from "#src/server/auth/require-user.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import { readFeedbackAttachment } from "#src/server/feedback/feedback.server";
import { getFileDelivery, type FileDelivery } from "#src/server/files/file-delivery.server";
import { PRIVATE_NO_STORE } from "#src/server/http/cache-control.server";
import { privateImageHeaders } from "#src/server/http/image-headers.server";

const uuidParam = z.uuid();

export const Route = createFileRoute("/api/feedback/attachments/$attachmentId")({
  server: {
    handlers: {
      GET: ({ params, request }) => handleFeedbackAttachmentDownload(request, params),
    },
  },
});

type AttachmentDependencies = {
  authenticate(cookieHeader: string | undefined): { id: string } | Promise<{ id: string }>;
  database(): PrismaClient | null | undefined;
  read: typeof readFeedbackAttachment;
  delivery(): FileDelivery | null;
};

const defaultDependencies: AttachmentDependencies = {
  async authenticate(cookieHeader) {
    const user = await optionalBrowserUser(cookieHeader);
    if (!user) throw new AppError("ACCESS_DENIED");
    return user;
  },
  database: getDatabaseClient,
  read: readFeedbackAttachment,
  delivery: getFileDelivery,
};

export async function handleFeedbackAttachmentDownload(
  request: Request,
  params: { attachmentId: string },
  dependencies: AttachmentDependencies = defaultDependencies,
): Promise<Response> {
  try {
    const user = await dependencies.authenticate(request.headers.get("cookie") ?? undefined);
    const db = dependencies.database();
    if (!db) throw new AppError("TEMPORARILY_UNAVAILABLE");
    if (!uuidParam.safeParse(params.attachmentId).success) throw new AppError("NOT_FOUND");
    const read = await dependencies.read(db, {
      attachmentId: params.attachmentId,
      userId: user.id,
    });

    const redirect = signedRedirect(dependencies, read.attachment.objectKey);
    if (redirect) return redirect;

    const file = await read.open();
    if (!file) throw new AppError("NOT_FOUND");

    return new Response(file.body, {
      headers: privateImageHeaders(read.attachment.contentType),
    });
  } catch (error) {
    if (!isAppError(error)) throw error;
    const status = error.code === "ACCESS_DENIED" ? 401 : error.code === "NOT_FOUND" ? 404 : 503;
    return Response.json(
      { code: error.code },
      { status, headers: { "cache-control": PRIVATE_NO_STORE } },
    );
  }
}

function signedRedirect(dependencies: AttachmentDependencies, objectKey: string): Response | null {
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

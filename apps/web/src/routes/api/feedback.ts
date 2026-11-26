import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import type { PrismaClient } from "#src/generated/prisma/client";
import {
  FEEDBACK_BODY_MAX_LENGTH,
  FEEDBACK_CATEGORIES,
  FEEDBACK_CLIENT_INFO_MAX_LENGTH,
  FEEDBACK_MAX_ATTACHMENTS,
  FEEDBACK_PAGE_PATH_MAX_LENGTH,
} from "#src/features/feedback/feedback-types";
import { AppError, isAppError } from "#src/lib/app-error";
import { isFile } from "#src/server/attachments/upload-file.server";
import { optionalBrowserUser } from "#src/server/auth/require-user.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import { submitUserFeedback } from "#src/server/feedback/feedback.server";
import { PRIVATE_NO_STORE } from "#src/server/http/cache-control.server";

const feedbackFormSchema = z.object({
  category: z.enum(FEEDBACK_CATEGORIES),
  body: z.string().trim().min(1).max(FEEDBACK_BODY_MAX_LENGTH),
  workspaceId: z.uuid().optional(),
  pagePath: z.string().max(FEEDBACK_PAGE_PATH_MAX_LENGTH).optional(),
  clientInfo: z.string().max(FEEDBACK_CLIENT_INFO_MAX_LENGTH).optional(),
  files: z.array(z.custom<File>(isFile)).max(FEEDBACK_MAX_ATTACHMENTS),
});

export const Route = createFileRoute("/api/feedback")({
  server: {
    handlers: {
      POST: ({ request }) => handleFeedbackSubmit(request),
    },
  },
});

type FeedbackSubmitDependencies = {
  authenticate(cookieHeader: string | undefined): { id: string } | Promise<{ id: string }>;
  database(): PrismaClient | null | undefined;
  submit: typeof submitUserFeedback;
};

const defaultDependencies: FeedbackSubmitDependencies = {
  async authenticate(cookieHeader) {
    const user = await optionalBrowserUser(cookieHeader);
    if (!user) throw new AppError("ACCESS_DENIED");
    return user;
  },
  database: getDatabaseClient,
  submit: submitUserFeedback,
};

function optionalStringField(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export async function handleFeedbackSubmit(
  request: Request,
  dependencies: FeedbackSubmitDependencies = defaultDependencies,
): Promise<Response> {
  try {
    const user = await dependencies.authenticate(request.headers.get("cookie") ?? undefined);
    const db = dependencies.database();
    if (!db) throw new AppError("TEMPORARILY_UNAVAILABLE");
    const form = await request.formData().catch(() => {
      throw new AppError("INVALID_INPUT");
    });
    const parsed = feedbackFormSchema.safeParse({
      category: form.get("category"),
      body: form.get("body"),
      workspaceId: optionalStringField(form, "workspaceId"),
      pagePath: optionalStringField(form, "pagePath"),
      clientInfo: optionalStringField(form, "clientInfo"),
      files: form.getAll("files"),
    });
    if (!parsed.success) throw new AppError("INVALID_INPUT");

    const created = await dependencies.submit(db, {
      userId: user.id,
      workspaceId: parsed.data.workspaceId ?? null,
      category: parsed.data.category,
      body: parsed.data.body,
      pagePath: parsed.data.pagePath ?? null,
      clientInfo: parsed.data.clientInfo ?? null,
      files: parsed.data.files,
    });
    return Response.json(created, {
      status: 201,
      headers: { "cache-control": PRIVATE_NO_STORE },
    });
  } catch (error) {
    return feedbackErrorResponse(error);
  }
}

function feedbackErrorResponse(error: unknown): Response {
  if (!isAppError(error)) throw error;
  const status =
    error.code === "ACCESS_DENIED"
      ? 401
      : error.code === "INVALID_INPUT"
        ? 400
        : error.code === "NOT_FOUND"
          ? 404
          : 503;
  return Response.json(
    { code: error.code },
    { status, headers: { "cache-control": PRIVATE_NO_STORE } },
  );
}

import type { PrismaClient } from "#src/generated/prisma/client";
import {
  FEEDBACK_ATTACHMENT_TYPES,
  FEEDBACK_BODY_MAX_LENGTH,
  FEEDBACK_CLIENT_INFO_MAX_LENGTH,
  FEEDBACK_MAX_ATTACHMENTS,
  FEEDBACK_PAGE_PATH_MAX_LENGTH,
  feedbackAttachmentUrl,
  isFeedbackCategory,
  isFeedbackStatus,
  sanitizeFeedbackFileName,
  type FeedbackCategory,
  type FeedbackInboxPayload,
  type FeedbackItemSummary,
  type FeedbackRoutingSummary,
  type FeedbackStatus,
} from "#src/features/feedback/feedback-types";
import { AppError } from "#src/lib/app-error";
import { readFileImageDimensions } from "#src/server/attachments/attachment-image-dimensions.server";
import {
  getFileStorage,
  type FileStorage,
  type StoredFile,
} from "#src/server/files/file-storage.server";
import { validateImage } from "#src/server/files/image-upload.server";
import {
  listOperatorRoutingChannels,
  readFeedbackRoutingSummary,
  routeFeedbackToChannel,
  writeFeedbackRoutingConfig,
  type FeedbackChannelRoutingDeps,
  type FeedbackChannelRoutingPayload,
  type FeedbackChannelRoutingResult,
} from "./feedback-channel-routing.server";

const FEEDBACK_LIST_LIMIT = 100;

export type SubmitUserFeedbackInput = {
  userId: string;
  workspaceId?: string | null;
  category: FeedbackCategory;
  body: string;
  pagePath?: string | null;
  clientInfo?: string | null;
  files: readonly File[];
};

type FeedbackDeps = {
  storage?: FileStorage;
  routeToChannel?: (
    db: PrismaClient,
    payload: FeedbackChannelRoutingPayload,
    deps?: FeedbackChannelRoutingDeps,
  ) => Promise<FeedbackChannelRoutingResult | null>;
  routingDeps?: FeedbackChannelRoutingDeps;
};

function normalizeOptionalText(value: string | null | undefined, maxLength: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function normalizePagePath(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalText(value, FEEDBACK_PAGE_PATH_MAX_LENGTH);
  if (!normalized || !normalized.startsWith("/")) return null;
  return normalized;
}

export async function isPlatformOperator(db: PrismaClient, userId: string): Promise<boolean> {
  const row = await db.platformOperator.findUnique({
    where: { userId },
    select: { role: true },
  });
  return row?.role === "app_reviewer";
}

export async function submitUserFeedback(
  db: PrismaClient,
  input: SubmitUserFeedbackInput,
  deps: FeedbackDeps = {},
): Promise<{ id: string; createdAt: string }> {
  if (!isFeedbackCategory(input.category)) throw new AppError("INVALID_INPUT");
  const body = input.body.trim();
  if (!body || body.length > FEEDBACK_BODY_MAX_LENGTH) throw new AppError("INVALID_INPUT");
  if (input.files.length > FEEDBACK_MAX_ATTACHMENTS) throw new AppError("INVALID_INPUT");

  for (const file of input.files) {
    await validateImage(file, FEEDBACK_ATTACHMENT_TYPES);
  }

  let verifiedWorkspaceId: string | null = null;
  if (input.workspaceId) {
    const membership = await db.workspaceMembership.findUnique({
      where: {
        workspaceId_userId: { workspaceId: input.workspaceId, userId: input.userId },
      },
      select: { workspaceId: true },
    });
    verifiedWorkspaceId = membership?.workspaceId ?? null;
  }

  const uploaded: {
    fileName: string;
    contentType: string;
    sizeBytes: number;
    objectKey: string;
    imageWidth: number | null;
    imageHeight: number | null;
  }[] = [];
  const storage = input.files.length > 0 ? (deps.storage ?? (await getFileStorage())) : undefined;

  try {
    if (storage && input.files.length > 0) {
      for (const file of input.files) {
        const objectKey = `feedback/${crypto.randomUUID()}/original`;
        const dimensions = await readFileImageDimensions(file, file.type);
        await storage.put(objectKey, file, file.type);
        uploaded.push({
          fileName: sanitizeFeedbackFileName(file.name),
          contentType: file.type,
          sizeBytes: file.size,
          objectKey,
          imageWidth: dimensions?.imageWidth ?? null,
          imageHeight: dimensions?.imageHeight ?? null,
        });
      }
    }

    const created = await db.userFeedback.create({
      data: {
        userId: input.userId,
        workspaceId: verifiedWorkspaceId,
        category: input.category,
        body,
        pagePath: normalizePagePath(input.pagePath),
        clientInfo: normalizeOptionalText(input.clientInfo, FEEDBACK_CLIENT_INFO_MAX_LENGTH),
        attachments:
          uploaded.length > 0
            ? {
                create: uploaded.map((item) => ({
                  fileName: item.fileName,
                  contentType: item.contentType,
                  sizeBytes: item.sizeBytes,
                  objectKey: item.objectKey,
                })),
              }
            : undefined,
      },
      select: {
        id: true,
        category: true,
        body: true,
        pagePath: true,
        clientInfo: true,
        createdAt: true,
        user: { select: { displayName: true, email: true } },
        workspace: { select: { name: true, slug: true } },
      },
    });

    const createdAt = created.createdAt.toISOString();
    const route = deps.routeToChannel ?? routeFeedbackToChannel;
    try {
      await route(
        db,
        {
          feedbackId: created.id,
          category: created.category as FeedbackCategory,
          body: created.body,
          authorName: created.user?.displayName ?? null,
          authorEmail: created.user?.email ?? null,
          workspaceName: created.workspace?.name ?? null,
          pagePath: created.pagePath,
          clientInfo: created.clientInfo,
          attachments: uploaded,
          createdAt,
        },
        {
          ...deps.routingDeps,
          storage: deps.routingDeps?.storage ?? storage,
        },
      );
    } catch {
      return { id: created.id, createdAt };
    }

    return { id: created.id, createdAt };
  } catch (error) {
    if (storage && uploaded.length > 0) {
      await Promise.allSettled(uploaded.map((item) => storage.remove(item.objectKey)));
    }
    throw error;
  }
}

async function queryUserFeedbackItems(
  db: PrismaClient,
  filter: { status?: FeedbackStatus },
): Promise<FeedbackItemSummary[]> {
  if (filter.status !== undefined && !isFeedbackStatus(filter.status)) {
    throw new AppError("INVALID_INPUT");
  }

  const rows = await db.userFeedback.findMany({
    where: filter.status ? { status: filter.status } : undefined,
    orderBy: { createdAt: "desc" },
    take: FEEDBACK_LIST_LIMIT,
    select: {
      id: true,
      category: true,
      body: true,
      status: true,
      pagePath: true,
      clientInfo: true,
      routedMessageId: true,
      createdAt: true,
      user: { select: { id: true, displayName: true, email: true } },
      workspace: { select: { id: true, name: true, slug: true } },
      routedConversation: {
        select: {
          id: true,
          channelName: true,
          hiddenFromWorkspaceAt: true,
          workspace: { select: { slug: true } },
        },
      },
      attachments: {
        orderBy: { createdAt: "asc" },
        select: { id: true, fileName: true, contentType: true, sizeBytes: true },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    category: isFeedbackCategory(row.category) ? row.category : "other",
    body: row.body,
    status: isFeedbackStatus(row.status) ? row.status : "open",
    pagePath: row.pagePath,
    clientInfo: row.clientInfo,
    createdAt: row.createdAt.toISOString(),
    author: row.user
      ? { id: row.user.id, name: row.user.displayName, email: row.user.email }
      : null,
    workspace: row.workspace
      ? { id: row.workspace.id, name: row.workspace.name, slug: row.workspace.slug }
      : null,
    routedChannel:
      row.routedConversation &&
      row.routedConversation.channelName &&
      !row.routedConversation.hiddenFromWorkspaceAt &&
      row.routedMessageId
        ? {
            workspaceSlug: row.routedConversation.workspace.slug,
            channelId: row.routedConversation.id,
            channelName: row.routedConversation.channelName,
            messageId: row.routedMessageId,
          }
        : null,
    attachments: row.attachments.map((attachment) => ({
      ...attachment,
      url: feedbackAttachmentUrl(attachment.id),
    })),
  }));
}

export async function listUserFeedback(
  db: PrismaClient,
  actorUserId: string,
  filter: { status?: FeedbackStatus } = {},
): Promise<FeedbackItemSummary[]> {
  if (!(await isPlatformOperator(db, actorUserId))) throw new AppError("ACCESS_DENIED");
  return queryUserFeedbackItems(db, filter);
}

export async function loadUserFeedbackInbox(
  db: PrismaClient,
  actorUserId: string,
  filter: { status?: FeedbackStatus } = {},
): Promise<FeedbackInboxPayload> {
  if (!(await isPlatformOperator(db, actorUserId))) throw new AppError("ACCESS_DENIED");
  if (filter.status !== undefined && !isFeedbackStatus(filter.status)) {
    throw new AppError("INVALID_INPUT");
  }
  const [items, routing, routingOptions] = await Promise.all([
    queryUserFeedbackItems(db, filter),
    readFeedbackRoutingSummary(db),
    listOperatorRoutingChannels(db, actorUserId),
  ]);
  return { items, routing, routingOptions };
}

export async function saveFeedbackRoutingConfig(
  db: PrismaClient,
  actorUserId: string,
  channelId: string | null,
): Promise<FeedbackRoutingSummary> {
  if (!(await isPlatformOperator(db, actorUserId))) throw new AppError("ACCESS_DENIED");
  return writeFeedbackRoutingConfig(db, actorUserId, channelId);
}

export async function updateUserFeedbackStatus(
  db: PrismaClient,
  actorUserId: string,
  input: { feedbackId: string; status: FeedbackStatus },
): Promise<void> {
  if (!(await isPlatformOperator(db, actorUserId))) throw new AppError("ACCESS_DENIED");
  if (!isFeedbackStatus(input.status)) throw new AppError("INVALID_INPUT");
  const updated = await db.userFeedback.updateMany({
    where: { id: input.feedbackId },
    data: { status: input.status },
  });
  if (updated.count === 0) throw new AppError("NOT_FOUND");
}

export async function readFeedbackAttachment(
  db: PrismaClient,
  input: { attachmentId: string; userId: string },
  deps: { storage?: FileStorage } = {},
): Promise<{
  attachment: { fileName: string; contentType: string; objectKey: string };
  open(): Promise<StoredFile | null>;
}> {
  const row = await db.userFeedbackAttachment.findUnique({
    where: { id: input.attachmentId },
    select: {
      fileName: true,
      contentType: true,
      objectKey: true,
      feedback: { select: { userId: true } },
    },
  });
  if (!row) throw new AppError("NOT_FOUND");
  const allowed =
    row.feedback.userId === input.userId || (await isPlatformOperator(db, input.userId));
  if (!allowed) throw new AppError("NOT_FOUND");
  const storage = deps.storage ?? (await getFileStorage());
  return {
    attachment: {
      fileName: row.fileName,
      contentType: row.contentType,
      objectKey: row.objectKey,
    },
    open: () => storage.open(row.objectKey),
  };
}

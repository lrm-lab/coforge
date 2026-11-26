import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import {
  loadUserFeedbackInbox,
  saveFeedbackRoutingConfig,
  updateUserFeedbackStatus,
} from "#src/server/feedback/feedback.server";
import {
  FEEDBACK_STATUSES,
  type FeedbackInboxPayload,
  type FeedbackRoutingSummary,
} from "./feedback-types";

export const loadFeedbackInbox = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z
      .object({
        status: z.enum(FEEDBACK_STATUSES).optional(),
      })
      .optional(),
  )
  .handler(async ({ data, context }): Promise<FeedbackInboxPayload> => {
    declareNoStore();
    return loadUserFeedbackInbox(context.db, context.user.id, { status: data?.status });
  });

export const updateFeedbackStatus = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      feedbackId: z.uuid(),
      status: z.enum(FEEDBACK_STATUSES),
    }),
  )
  .handler(async ({ data, context }): Promise<void> => {
    declareNoStore();
    await updateUserFeedbackStatus(context.db, context.user.id, data);
  });

export const saveFeedbackRouting = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      channelId: z.uuid().nullable(),
    }),
  )
  .handler(async ({ data, context }): Promise<FeedbackRoutingSummary> => {
    declareNoStore();
    return saveFeedbackRoutingConfig(context.db, context.user.id, data.channelId);
  });

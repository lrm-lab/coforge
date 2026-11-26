import { IMAGE_MAX_BYTES, IMAGE_UPLOAD_TYPES } from "#src/lib/image-upload";

export const FEEDBACK_CATEGORIES = ["bug", "idea", "other"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const FEEDBACK_STATUSES = ["open", "triaged", "resolved", "archived"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const FEEDBACK_BODY_MAX_LENGTH = 2000;
export const FEEDBACK_PAGE_PATH_MAX_LENGTH = 512;
export const FEEDBACK_CLIENT_INFO_MAX_LENGTH = 256;
export const FEEDBACK_FILE_NAME_MAX_LENGTH = 160;
export const FEEDBACK_MAX_ATTACHMENTS = 3;
export const FEEDBACK_ATTACHMENT_MAX_BYTES = IMAGE_MAX_BYTES;
export const FEEDBACK_ATTACHMENT_TYPES = IMAGE_UPLOAD_TYPES;

export type FeedbackAttachmentSummary = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  url: string;
};

export type FeedbackItemSummary = {
  id: string;
  category: FeedbackCategory;
  body: string;
  status: FeedbackStatus;
  pagePath: string | null;
  clientInfo: string | null;
  createdAt: string;
  author: {
    id: string;
    name: string;
    email: string | null;
  } | null;
  workspace: {
    id: string;
    name: string;
    slug: string;
  } | null;
  routedChannel: {
    workspaceSlug: string;
    channelId: string;
    channelName: string;
    messageId: string;
  } | null;
  attachments: FeedbackAttachmentSummary[];
};

export type FeedbackRoutingSummary = {
  channelId: string;
  channelName: string;
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
} | null;

export type FeedbackRoutingOption = {
  channelId: string;
  channelName: string;
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
};

export type FeedbackInboxPayload = {
  items: FeedbackItemSummary[];
  routing: FeedbackRoutingSummary;
  routingOptions: FeedbackRoutingOption[];
};

export function isFeedbackCategory(value: string): value is FeedbackCategory {
  return (FEEDBACK_CATEGORIES as readonly string[]).includes(value);
}

export function isFeedbackStatus(value: string): value is FeedbackStatus {
  return (FEEDBACK_STATUSES as readonly string[]).includes(value);
}

export function sanitizeFeedbackFileName(raw: string): string {
  const base = raw.split(/[\\/]/).at(-1)?.trim() ?? "";
  let cleaned = "";
  for (const char of base) {
    const code = char.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) cleaned += char;
    if (cleaned.length >= FEEDBACK_FILE_NAME_MAX_LENGTH) break;
  }
  return cleaned || "screenshot.png";
}

export function feedbackAttachmentUrl(attachmentId: string): string {
  return `/api/feedback/attachments/${encodeURIComponent(attachmentId)}`;
}

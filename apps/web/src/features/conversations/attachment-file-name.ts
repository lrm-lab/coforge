import { isDisplayableImageAttachment } from "#src/lib/inline-image";

/**
 * Body shown beside message attachments. The composer uses the first filename to satisfy the
 * non-empty body contract for an attachment-only send; for image-only messages that value is a
 * transport placeholder rather than a caption.
 */
export function attachmentMessageDisplayBody(message: {
  body: string;
  weeklyReportDisplayBody?: string;
  attachments: {
    fileName: string;
    contentType: string;
    previewUrl?: string;
    thumbnailUrl?: string;
    largeUrl?: string;
    iconUrl?: string;
  }[];
}): string {
  if (
    !message.weeklyReportDisplayBody &&
    message.attachments.length > 0 &&
    message.attachments.every((attachment) => isDisplayableImageAttachment(attachment)) &&
    message.body === message.attachments[0]?.fileName
  )
    return "";
  return message.weeklyReportDisplayBody ?? message.body;
}

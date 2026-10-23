/**
 * One derived filename for a message's attachments, as a lightweight list or jump index shows it:
 * the first (send order) plus a count of the rest, e.g. `photo.png (+2 more)`.
 *
 * Shared by `ConversationHistory.ownMessages` (server) and the own-messages index in
 * `conversation-pane.tsx` (browser), so the two never drift. It deliberately carries no
 * server-only imports: the browser bundle and server-only modules can import the same definition.
 */
export function attachmentFileNameSummary(attachments: { fileName: string }[]): string | undefined {
  const [first, ...rest] = attachments;
  if (!first) return undefined;
  return rest.length ? `${first.fileName} (+${rest.length} more)` : first.fileName;
}

/**
 * Body shown beside message attachments. The composer uses the first filename to satisfy the
 * non-empty body contract for an attachment-only send; for image-only messages that value is a
 * transport placeholder rather than a caption.
 */
export function attachmentMessageDisplayBody(message: {
  body: string;
  weeklyReportDisplayBody?: string;
  attachments: { fileName: string; contentType: string }[];
}): string {
  if (
    !message.weeklyReportDisplayBody &&
    message.attachments.length > 0 &&
    message.attachments.every((attachment) => attachment.contentType.startsWith("image/")) &&
    message.body === message.attachments[0]?.fileName
  )
    return "";
  return message.weeklyReportDisplayBody ?? message.body;
}

/**
 * Whether the viewer wrote `message`, in a channel and a direct conversation alike: its sender is
 * the viewer's own member row there (the view's `senderMemberId`). An Agent's message has its own
 * member row and a system message none, so neither is ever the viewer's, and a viewer with no
 * member row (a channel preview) owns nothing. A message without `senderMemberId` (a DM page
 * stored before DMs carried it) is not own; `STORED_SHAPE_VERSION` keeps such pages out.
 */
export function isViewerMessage(
  message: { senderMemberId?: string | null },
  viewerMemberId: string | undefined,
): boolean {
  return Boolean(viewerMemberId) && message.senderMemberId === viewerMemberId;
}

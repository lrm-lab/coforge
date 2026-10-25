import { AppError } from "#src/lib/app-error";
import {
  anchorTypeForPreview,
  type AttachmentCommentAnchor,
} from "#src/features/conversations/attachment-comment-anchors";
import { attachmentPreviewKind } from "#src/features/conversations/attachment-preview-kind";
import type { mapBrowserMessage } from "#src/server/conversations/conversation-history.server";

export type AttachmentCommentActor = { workspaceId: string } & (
  | { userId: string; agentId?: never }
  | { agentId: string; userId?: never }
);
export type AttachmentCommentAccess = {
  workspaceId: string;
  attachmentId: string;
  fileName: string;
  contentType: string;
  sourceConversationId: string;
  conversationId: string | null;
  canRead: boolean;
  activeMember: boolean;
  archived: boolean;
  readOnly: boolean;
};
export type AttachmentCommentView = ReturnType<typeof mapBrowserMessage> & {
  anchor: AttachmentCommentAnchor | null;
  resolved: boolean;
  replyTarget: string;
};
export type AttachmentCommentPageInput = {
  attachmentId: string;
  beforeSequence?: number;
  limit?: number;
};
export type AttachmentCommentPostInput = {
  attachmentId: string;
  body: string;
  anchor?: AttachmentCommentAnchor;
};
export interface AttachmentCommentStore {
  access(
    actor: AttachmentCommentActor,
    attachmentId: string,
  ): Promise<AttachmentCommentAccess | null>;
  list(
    input: AttachmentCommentPageInput,
  ): Promise<{ comments: AttachmentCommentView[]; hasOlder: boolean }>;
  post(
    actor: AttachmentCommentActor,
    input: AttachmentCommentPostInput,
    authorize: (access: AttachmentCommentAccess | null) => void,
  ): Promise<AttachmentCommentView>;
}

function readable(
  access: AttachmentCommentAccess | null,
): asserts access is AttachmentCommentAccess {
  if (!access) throw new AppError("NOT_FOUND");
  if (!access.canRead) throw new AppError("NOT_FOUND");
}
export function attachmentCommentDisabledReason(access: AttachmentCommentAccess) {
  if (access.archived) return "archived" as const;
  if (access.readOnly) return "read-only" as const;
  if (!access.activeMember) return "not-member" as const;
  return null;
}

/** Comments inherit the source attachment's authority on every read and transactional write. */
export class AttachmentComments {
  constructor(private readonly store: AttachmentCommentStore) {}

  async list(actor: AttachmentCommentActor, input: AttachmentCommentPageInput) {
    const access = await this.store.access(actor, input.attachmentId);
    readable(access);
    const disabledReason = attachmentCommentDisabledReason(access);
    const page = await this.store.list(input);
    return {
      ...page,
      attachmentId: input.attachmentId,
      conversationId: access.conversationId,
      threadTarget: `attachment:${input.attachmentId}`,
      canComment: disabledReason === null,
      disabledReason,
    };
  }

  async post(actor: AttachmentCommentActor, input: AttachmentCommentPostInput) {
    const body = input.body.trim();
    if (!body || body.length > 8_000) throw new AppError("INVALID_INPUT");
    return this.store.post(actor, { ...input, body }, (access) => {
      readable(access);
      const reason = attachmentCommentDisabledReason(access);
      if (reason) throw new AppError("ACCESS_DENIED", { errorId: `attachment-comments-${reason}` });
      // Only the position kind this file's preview offers; the file's content is never read here.
      if (
        input.anchor &&
        input.anchor.type !==
          anchorTypeForPreview(attachmentPreviewKind(access.fileName, access.contentType))
      )
        throw new AppError("INVALID_INPUT");
    });
  }
}

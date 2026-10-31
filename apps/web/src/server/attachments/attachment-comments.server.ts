import { isValidReactionEmoji, type MentionSelectorInput } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import {
  anchorTypeForPreview,
  type AttachmentCommentAnchor,
} from "#src/features/conversations/attachment-comment-anchors";
import { previewKindFor, takesComments } from "#src/features/conversations/attachment-preview-kind";
import type { mapBrowserMessage } from "#src/server/conversations/conversation-history.server";
import type { VersionedReactions } from "#src/server/conversations/reaction-write.server";

export type AttachmentCommentActor = { workspaceId: string } & (
  | { userId: string; agentId?: never }
  | { agentId: string; userId?: never }
);
export type AttachmentCommentAccess = {
  workspaceId: string;
  attachmentId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
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
  /** Where a reply to this comment goes: its root comment's thread. */
  replyTarget: string;
  /** Replies under a root comment; 0 for a reply. */
  replyCount: number;
};
export type AttachmentCommentPageInput = {
  attachmentId: string;
  /** The root comment whose replies to page through; without it, the root comments. */
  rootId?: string;
  beforeSequence?: number;
  limit?: number;
};
export type AttachmentCommentPostInput = {
  attachmentId: string;
  body: string;
  anchor?: AttachmentCommentAnchor;
  /** The comment this replies to; a reply to a reply joins the same root comment's thread. */
  rootId?: string;
  /** Members the sender named by id, beside the `@handle`s in `body`; resolved among the
   * source conversation's active members. */
  mentions?: readonly MentionSelectorInput[];
};

/** Who a committed comment notified: people to wake on Activity, and the Agent delivery rows
 * still to push (each `{deliveryId, agentId}`; the push re-reads them, so a replayed send
 * publishes the same envelopes the first did). */
export type AttachmentCommentPosted = {
  comment: AttachmentCommentView;
  notified: {
    workspaceId: string;
    attachmentId: string;
    userIds: readonly string[];
    deliveries: readonly { deliveryId: string; agentId: string }[];
  };
};

/** Post-commit realtime wake for a posted comment: `activityChanged` for the people, an
 * AgentMessageDelivery push for the Agents. Best effort — the rows are the record; a missed
 * push is caught up by the next inbox read or daemon recovery. */
export type AttachmentCommentNotices = {
  publish(posted: AttachmentCommentPosted): Promise<void>;
};
export type AttachmentCommentReactInput = {
  attachmentId: string;
  messageId: string;
  emoji: string;
  active: boolean;
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
  ): Promise<AttachmentCommentPosted>;
  react(
    actor: AttachmentCommentActor,
    input: AttachmentCommentReactInput,
    authorize: (access: AttachmentCommentAccess | null) => void,
  ): Promise<VersionedReactions>;
}

function readable(
  access: AttachmentCommentAccess | null,
): asserts access is AttachmentCommentAccess {
  if (!access) throw new AppError("NOT_FOUND");
  if (!access.canRead) throw new AppError("NOT_FOUND");
}
/** Writing (commenting, replying, reacting) needs what reading does, on a source still open to the actor. */
function writable(
  access: AttachmentCommentAccess | null,
): asserts access is AttachmentCommentAccess {
  readable(access);
  const reason = attachmentCommentDisabledReason(access);
  if (reason) throw new AppError("ACCESS_DENIED", { errorId: `attachment-comments-${reason}` });
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

  async readAccess(actor: AttachmentCommentActor, attachmentId: string) {
    const access = await this.store.access(actor, attachmentId);
    readable(access);
    return access;
  }

  async list(actor: AttachmentCommentActor, input: AttachmentCommentPageInput) {
    const access = await this.readAccess(actor, input.attachmentId);
    const disabledReason = attachmentCommentDisabledReason(access);
    const page = await this.store.list(input);
    return {
      ...page,
      attachmentId: input.attachmentId,
      conversationId: access.conversationId,
      threadTarget: `attachment:${input.attachmentId}`,
      // A file that takes no comments (no preview, or a PDF) keeps those it has readable and
      // resolvable, but takes no new ones.
      canComment: disabledReason === null && takesComments(access),
      canReact: disabledReason === null,
      disabledReason,
    };
  }

  async post(
    actor: AttachmentCommentActor,
    input: AttachmentCommentPostInput,
    notices?: AttachmentCommentNotices,
  ) {
    const body = input.body.trim();
    if (!body || body.length > 8_000) throw new AppError("INVALID_INPUT");
    // A reply follows its root comment's place rather than having one of its own.
    if (input.rootId && input.anchor) throw new AppError("INVALID_INPUT");
    const posted = await this.store.post(actor, { ...input, body }, (access) => {
      writable(access);
      // A file no one can look at takes no new comments (those it already has stay); one that can
      // takes only the position kind its preview offers. The file's content is never read here.
      if (!takesComments(access))
        throw new AppError("ACCESS_DENIED", { errorId: "attachment-comments-no-preview" });
      if (input.anchor && input.anchor.type !== anchorTypeForPreview(previewKindFor(access)))
        throw new AppError("INVALID_INPUT");
    });
    // Realtime is best effort only: the notification rows committed with the comment, and a
    // missed wake is caught up by the next inbox read or daemon recovery.
    if (notices && (posted.notified.userIds.length || posted.notified.deliveries.length))
      await notices.publish(posted).catch(() => {});
    return posted.comment;
  }

  /** A reaction on one comment or reply, any emoji; ✅ is what makes a comment resolved. */
  async react(actor: AttachmentCommentActor, input: AttachmentCommentReactInput) {
    if (!isValidReactionEmoji(input.emoji)) throw new AppError("INVALID_INPUT");
    return this.store.react(actor, input, writable);
  }
}

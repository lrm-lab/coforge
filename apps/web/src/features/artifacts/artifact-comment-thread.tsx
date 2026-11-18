import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  CornerUpLeft,
  DotsHorizontal,
  Edit03,
  RefreshCcw01,
  Trash01,
  CheckCircle,
} from "@untitledui/icons";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { TextArea } from "#src/components/base/textarea/textarea";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { submitOnModEnter } from "#src/components/ui/dialog-form-keys";
import { RelativeTime } from "#src/components/ui/relative-time";
import { useAppToast } from "#src/components/ui/toast";
import type { ChipMention } from "#src/features/conversations/message-reference-chips";
import { MessageBody } from "#src/features/conversations/message-body";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { cn } from "#src/lib/utils";
import {
  COMMENT_AUTHOR_CLASS,
  COMMENT_BODY_CLASS,
  COMMENT_FLASH_CLASS,
  COMMENT_META_CLASS,
  COMMENT_ROW_CLASS,
} from "#src/features/conversations/review-chrome";
import { m } from "#src/paraglide/messages";
import {
  deleteArtifactComment,
  editArtifactComment,
  reopenArtifactComment,
  resolveArtifactComment,
} from "./artifact-comments.functions";
import { commentImageUrl } from "./artifact-comment-images";
import { syncOwnComments, type ArtifactCommentView } from "./artifact-comment-queries";
import { CommentAnchorLine } from "./artifact-comment-anchor";
import { CommentAuthorAvatar } from "./artifact-comment-avatar";
import type { CommentThread } from "./artifact-comment-threads";
import type { CommentReplyTarget } from "./artifact-comment-composer";

type Live = Exclude<ArtifactCommentView, { deleted: true }>;

const isLive = (comment: ArtifactCommentView): comment is Live => !("deleted" in comment);

export type CommentContext = {
  artifactId: string;
  plainMentions: Map<string, ChipMention> | undefined;
  flashId: string | null;
  onReply: (target: CommentReplyTarget) => void;
};

function useCommentActions(artifactId: string) {
  const queryClient = useQueryClient();
  const toast = useAppToast();
  const sync = (change: Parameters<typeof syncOwnComments>[2], commentId: string) =>
    syncOwnComments(queryClient, artifactId, change, [commentId]);
  const attempt = async (work: () => Promise<unknown>, done?: string) => {
    try {
      await work();
      if (done) toast.success(done);
    } catch {
      toast.error(m.av_cm_action_failed());
    }
  };
  return {
    resolve: (commentId: string) =>
      attempt(async () => {
        await resolveArtifactComment({ data: { artifactId, commentId } });
        await sync("resolved", commentId);
      }, m.av_cm_resolved_toast()),
    reopen: (commentId: string) =>
      attempt(async () => {
        await reopenArtifactComment({ data: { artifactId, commentId } });
        await sync("reopened", commentId);
      }, m.av_cm_reopened_toast()),
    edit: (commentId: string, body: string) =>
      attempt(async () => {
        await editArtifactComment({ data: { artifactId, commentId, body } });
        await sync("edited", commentId);
      }),
    remove: async (commentId: string) => {
      await deleteArtifactComment({ data: { artifactId, commentId } });
      await sync("deleted", commentId);
    },
  };
}

export function CommentThreadView({
  thread,
  context,
  versionTag,
}: {
  thread: CommentThread;
  context: CommentContext;
  versionTag: boolean;
}) {
  const actions = useCommentActions(context.artifactId);
  return (
    <li
      data-comment-thread={thread.root.id}
      className={cn(
        "overflow-hidden rounded-lg border border-secondary bg-primary transition-colors duration-300",
        context.flashId === thread.root.id && COMMENT_FLASH_CLASS,
      )}
    >
      <ul className="divide-y divide-secondary">
        {[thread.root, ...thread.replies].map((comment) => (
          <li key={comment.id}>
            <CommentRow
              comment={comment}
              isRoot={comment.id === thread.root.id}
              versionTag={versionTag && comment.id === thread.root.id}
              context={context}
              actions={actions}
            />
          </li>
        ))}
      </ul>
    </li>
  );
}

type RowAction = {
  id: string;
  icon: typeof CornerUpLeft;
  label: string;
  toolbar?: boolean;
  run: () => void;
};

function CommentRow({
  comment,
  isRoot,
  versionTag,
  context,
  actions,
}: {
  comment: ArtifactCommentView;
  isRoot: boolean;
  versionTag: boolean;
  context: CommentContext;
  actions: ReturnType<typeof useCommentActions>;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  if (!isLive(comment))
    return (
      <p data-comment-id={comment.id} className="p-3 text-sm text-tertiary">
        {m.av_cm_deleted()}
      </p>
    );
  const { author } = comment;
  const resolved = isRoot && comment.resolvedAt !== null;
  const rowActions: RowAction[] = [
    {
      id: "reply",
      icon: CornerUpLeft,
      label: m.av_cm_reply(),
      toolbar: true,
      run: () => context.onReply({ id: comment.id, name: author.name }),
    },
  ];
  if (isRoot && comment.canResolve)
    rowActions.push(
      resolved
        ? {
            id: "reopen",
            icon: RefreshCcw01,
            label: m.av_cm_reopen(),
            toolbar: true,
            run: () => void actions.reopen(comment.id),
          }
        : {
            id: "resolve",
            icon: CheckCircle,
            label: m.av_cm_resolve(),
            toolbar: true,
            run: () => void actions.resolve(comment.id),
          },
    );
  if (comment.mine)
    rowActions.push(
      { id: "edit", icon: Edit03, label: m.av_cm_edit(), run: () => setEditing(true) },
      {
        id: "delete",
        icon: Trash01,
        label: m.av_cm_delete(),
        run: () => setConfirmingDelete(true),
      },
    );
  return (
    <article
      data-comment-id={comment.id}
      className={cn(
        COMMENT_ROW_CLASS,
        "group/comment relative transition-colors duration-150 hover:bg-primary_hover",
      )}
    >
      <CommentAuthorAvatar comment={comment} size="sm" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <header className="flex min-h-6 min-w-0 flex-wrap items-center gap-x-2 pr-16">
          <span className={cn(COMMENT_AUTHOR_CLASS, "min-w-0")}>{author.name}</span>
          {author.kind === "agent" && (
            <Badge size="sm" color="gray" type="modern">
              {m.member_agent()}
            </Badge>
          )}
          <RelativeTime value={comment.createdAt} plain className={COMMENT_META_CLASS} />
          {comment.editedAt && <span className={COMMENT_META_CLASS}>{m.av_cm_edited()}</span>}
          {versionTag && (
            <span className={COMMENT_META_CLASS}>
              {m.av_cm_version({ version: comment.version })}
            </span>
          )}
        </header>
        {isRoot && (
          <CommentAnchorLine
            commentId={comment.id}
            version={comment.version}
            path={comment.path}
            anchor={comment.anchor}
          />
        )}
        {editing ? (
          <CommentEditor
            initial={comment.body}
            onCancel={() => setEditing(false)}
            onSave={async (body) => {
              await actions.edit(comment.id, body);
              setEditing(false);
            }}
          />
        ) : (
          <>
            {comment.body && (
              <div className={cn(COMMENT_BODY_CLASS, "message-text min-w-0")}>
                <MessageBody body={comment.body} plainMentions={context.plainMentions} />
              </div>
            )}
            <CommentImages artifactId={context.artifactId} images={comment.images} />
          </>
        )}
        {resolved && comment.resolvedBy && comment.resolvedAt && (
          <p className="text-xs text-tertiary">
            {m.av_cm_resolved_by({ name: comment.resolvedBy.name })} ·{" "}
            <RelativeTime value={comment.resolvedAt} plain />
          </p>
        )}
      </div>
      {!editing && (
        <div
          className={cn(
            "absolute top-2 right-2 flex items-center",
            "opacity-0 transition-opacity group-hover/comment:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100",
          )}
        >
          {rowActions
            .filter((action) => action.toolbar)
            .map((action) => (
              <ButtonUtility
                key={action.id}
                icon={action.icon}
                size="xs"
                color="tertiary"
                tooltip={action.label}
                onClick={action.run}
              />
            ))}
          <Dropdown.Root>
            <ButtonUtility
              icon={DotsHorizontal}
              size="xs"
              color="tertiary"
              tooltip={m.av_cm_actions({ name: author.name })}
            />
            <Dropdown.Popover placement="bottom end">
              <Dropdown.Menu
                aria-label={m.av_cm_actions({ name: author.name })}
                onAction={(key) => rowActions.find((action) => action.id === key)?.run()}
              >
                {rowActions.map((action) => (
                  <Dropdown.Item
                    key={action.id}
                    id={action.id}
                    icon={action.icon}
                    label={action.label}
                  />
                ))}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.Root>
        </div>
      )}
      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={m.av_cm_delete_title()}
        description={m.av_cm_delete_body()}
        confirmLabel={m.av_cm_delete_confirm()}
        errorMessage={m.av_cm_delete_failed()}
        onConfirm={async () => {
          await actions.remove(comment.id);
          setConfirmingDelete(false);
        }}
      />
    </article>
  );
}

export function CommentEditor({
  initial,
  onCancel,
  onSave,
}: {
  initial: string;
  onCancel: () => void;
  onSave: (body: string) => Promise<void>;
}) {
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  return (
    <form
      onKeyDown={submitOnModEnter}
      className="flex flex-col gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!text.trim() || saving) return;
        setSaving(true);
        try {
          await onSave(text);
        } finally {
          setSaving(false);
        }
      }}
    >
      <TextArea
        autoFocus
        size="sm"
        value={text}
        rows={3}
        maxLength={8000}
        aria-label={m.av_cm_edit()}
        isDisabled={saving}
        onChange={setText}
        textAreaClassName="resize-y p-2"
        onTextAreaKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" color="secondary" onClick={onCancel}>
          {m.av_cm_edit_cancel()}
        </Button>
        <Button
          size="sm"
          color="primary"
          type="submit"
          isDisabled={!text.trim()}
          isLoading={saving}
        >
          {m.av_cm_edit_save()}
        </Button>
      </div>
    </form>
  );
}

function CommentImages({
  artifactId,
  images,
}: {
  artifactId: string;
  images: readonly { id: string; width: number; height: number }[];
}) {
  const workspaceSlug = useWorkspaceSlug();
  if (images.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2">
      {images.map((image) => {
        const url = commentImageUrl(workspaceSlug, artifactId, image.id);
        return (
          <li key={image.id}>
            <a href={url} target="_blank" rel="noreferrer">
              <img
                src={url}
                alt={m.av_cm_image_alt()}
                width={image.width}
                height={image.height}
                loading="lazy"
                className="max-h-40 w-auto max-w-full rounded-md border border-secondary object-contain"
              />
            </a>
          </li>
        );
      })}
    </ul>
  );
}

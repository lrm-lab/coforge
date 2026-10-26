import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Copy01, Download01, MessageSquare01, XClose } from "@untitledui/icons";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import {
  Dialog,
  DialogTrigger,
  Modal,
  ModalOverlay,
} from "#src/components/application/modals/modal";
import { Empty, EmptyTitle } from "#src/components/ui/empty";
import { useAppToast } from "#src/components/ui/toast";
import { fileTypeLabel } from "#src/features/files/file-meta";
import { copyText } from "#src/lib/clipboard";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { AnchorSurface, Anchoring } from "./attachment-anchoring";
import type { AttachmentCommentAnchor } from "./attachment-comment-anchors";
import { AttachmentCommentsPane } from "./attachment-comments";
import { AttachmentPreview } from "./attachment-preview";
import {
  TEXT_PREVIEW_MAX_BYTES,
  isTextPreviewKind,
  previewKindFor,
} from "./attachment-preview-kind";
import { readPreviewText } from "./attachment-preview-text";

type ReviewFile = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  previewUrl?: string;
};

// The icon bar is drawn at full text color, as on Raft; the tertiary gray reads as disabled.
const TOOLBAR_ICON = "text-fg-primary hover:text-fg-primary";

/**
 * All file types have a discussion, even when this deployment cannot preview their bytes.
 *
 * A previewable file fills the screen under an icon bar, its comments closed until asked for, as
 * on Raft's page. One without a preview keeps a small dialog of its discussion alone, where Raft
 * downloads it: every file here has a discussion an Agent may write under, so the reader needs a
 * way in to it.
 *
 * A text preview is read before the dialog opens, as in Raft: `children` (the card) shows
 * `loading` meanwhile, and a file that turns out to have no preview opens its discussion alone,
 * like any other file without one.
 */
export function AttachmentReviewDialog({
  file,
  children,
}: {
  file: ReviewFile;
  children: (state: { loading: boolean }) => ReactNode;
}) {
  // A preview opens on the file alone; on an HTML page showing the comments also marks regions.
  const [commentsExpanded, setCommentsExpanded] = useState(false);
  const [commentsOnPhone, setCommentsOnPhone] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [imageUrlFailed, setImageUrlFailed] = useState(false);
  const [pendingAnchor, setPendingAnchor] = useState<AttachmentCommentAnchor | null>(null);
  const [surface, setSurface] = useState<AnchorSurface | null>(null);
  const [jumpTo, setJumpTo] = useState<AttachmentCommentAnchor | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const anchoring = useMemo<Anchoring>(
    () => ({
      onSurface: setSurface,
      onComment(anchor) {
        setPendingAnchor(anchor);
        setFocusRequest((count) => count + 1);
        setCommentsExpanded(true);
        setCommentsOnPhone(true);
      },
    }),
    [],
  );
  // Jump once the preview is showing: on a phone it is hidden behind the comments until then.
  useEffect(() => {
    if (!jumpTo || !surface || commentsOnPhone) return;
    surface.jump(jumpTo);
    setJumpTo(null);
  }, [jumpTo, surface, commentsOnPhone]);
  const href = `/api/attachments/${file.id}`;
  const available = previewKindFor(file);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  // The text a preview shows, read once per card: `null` when it turned out to have none.
  const [text, setText] = useState<string | null | undefined>(undefined);
  const reading = useRef<AbortController | null>(null);
  useEffect(() => () => reading.current?.abort(), []);
  const kind = isTextPreviewKind(available) && text === null ? null : available;
  const onOpenChange = (next: boolean) => {
    if (!next) {
      setOpen(false);
      setPendingAnchor(null);
      return;
    }
    if (!isTextPreviewKind(available) || text !== undefined) return setOpen(true);
    if (loading) return;
    setLoading(true);
    const controller = new AbortController();
    reading.current = controller;
    void readPreviewText(href, TEXT_PREVIEW_MAX_BYTES[available], controller.signal).then(
      (value) => {
        setText(value);
        setLoading(false);
        setOpen(true);
      },
      // Aborted: the card is gone.
      () => {},
    );
  };
  const image = file.contentType.startsWith("image/") && !imageFailed;
  const canPreview = file.contentType.startsWith("image/") || kind !== null;
  const showComments = commentsOnPhone || !canPreview;
  const commentsShown = commentsOnPhone || commentsExpanded;
  const toast = useAppToast();
  const copyLabel =
    kind === "markdown"
      ? m.attachment_preview_copy_markdown()
      : kind === "text"
        ? m.attachment_preview_copy()
        : null;
  const typeLabel = fileTypeLabel(file.fileName, file.contentType);
  return (
    <DialogTrigger isOpen={open} onOpenChange={onOpenChange}>
      {children({ loading })}
      <ModalOverlay
        isDismissable
        className={cn(
          canPreview &&
            "px-0 backdrop-blur-none sm:px-0 [--modal-pb:0px] [--modal-pt:0px] sm:[--modal-pb:0px] sm:[--modal-pt:0px]",
        )}
      >
        <Modal
          className={cn(
            "w-full max-sm:overflow-hidden",
            canPreview
              ? "h-dvh max-h-dvh rounded-none shadow-none sm:rounded-none"
              : "h-full max-h-full sm:h-[85vh] sm:max-w-lg",
          )}
        >
          <Dialog aria-label={file.fileName} className="flex h-full flex-col overflow-hidden">
            {({ close }) => (
              <>
                <div className="flex h-14 shrink-0 items-center gap-1 border-b border-secondary pr-2 pl-4">
                  <p className="flex min-w-0 flex-1 items-center gap-2">
                    {typeLabel && (
                      <span className="shrink-0 rounded-sm bg-secondary px-1 py-0.5 text-xs leading-none font-semibold text-tertiary ring-1 ring-secondary ring-inset">
                        {typeLabel}
                      </span>
                    )}
                    <span className="truncate text-sm font-semibold text-primary">
                      {file.fileName}
                    </span>
                  </p>
                  {canPreview && (
                    <ButtonUtility
                      icon={MessageSquare01}
                      size="sm"
                      color="tertiary"
                      tooltip={m.attachment_comments_title()}
                      aria-pressed={commentsShown}
                      className={cn(
                        TOOLBAR_ICON,
                        commentsShown && "bg-brand-primary_alt text-fg-brand-primary",
                      )}
                      onClick={() => {
                        setCommentsOnPhone(!commentsShown);
                        setCommentsExpanded(!commentsShown);
                      }}
                    />
                  )}
                  {copyLabel && text && (
                    <ButtonUtility
                      icon={Copy01}
                      size="sm"
                      color="tertiary"
                      tooltip={copyLabel}
                      className={TOOLBAR_ICON}
                      onClick={() =>
                        void copyText(text).then(
                          (copied) => copied && toast.success(m.controls_copied()),
                        )
                      }
                    />
                  )}
                  <ButtonUtility
                    icon={Download01}
                    size="sm"
                    color="tertiary"
                    tooltip={m.attachment_preview_download({ name: file.fileName })}
                    className={TOOLBAR_ICON}
                    href={`${href}?download`}
                  />
                  <ButtonUtility
                    icon={XClose}
                    size="sm"
                    color="tertiary"
                    tooltip={m.controls_close()}
                    className={TOOLBAR_ICON}
                    onClick={close}
                  />
                </div>
                <div className="flex min-h-0 flex-1">
                  {canPreview && (
                    <div
                      className={cn(
                        "min-h-0 min-w-0 flex-1 flex-col overflow-auto lg:flex",
                        commentsOnPhone ? "hidden" : "flex",
                      )}
                    >
                      {image ? (
                        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
                          <img
                            src={!imageUrlFailed && file.previewUrl ? file.previewUrl : href}
                            alt={file.fileName}
                            className="max-h-full max-w-full object-contain"
                            onError={() => {
                              if (file.previewUrl && !imageUrlFailed) setImageUrlFailed(true);
                              else setImageFailed(true);
                            }}
                          />
                        </div>
                      ) : kind ? (
                        <AttachmentPreview
                          fileName={file.fileName}
                          kind={kind}
                          href={href}
                          previewUrl={file.previewUrl}
                          text={text ?? undefined}
                          anchoring={anchoring}
                          commentsOpen={commentsExpanded}
                        />
                      ) : (
                        <Empty>
                          <EmptyTitle>{m.attachment_comments_no_preview()}</EmptyTitle>
                        </Empty>
                      )}
                    </div>
                  )}
                  <div
                    className={cn(
                      "min-h-0 min-w-0 flex-1",
                      canPreview && "lg:w-80 lg:flex-none lg:border-l lg:border-secondary",
                      canPreview && (commentsExpanded ? "lg:block" : "lg:hidden"),
                      showComments ? "block" : "hidden",
                    )}
                  >
                    <AttachmentCommentsPane
                      attachmentId={file.id}
                      fileName={file.fileName}
                      pendingAnchor={pendingAnchor}
                      focusRequest={focusRequest}
                      onClearAnchor={(anchor) =>
                        setPendingAnchor((current) => (current === anchor ? null : current))
                      }
                      surface={surface}
                      onJump={(anchor) => {
                        setCommentsOnPhone(false);
                        setJumpTo(anchor);
                      }}
                    />
                  </div>
                </div>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}

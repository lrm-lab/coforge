import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Copy01, Download01, MessageSquare01, XClose } from "@untitledui/icons";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dialog, DialogTrigger, Modal, ModalOverlay } from "#src/components/ui/modal";
import { Empty, EmptyTitle } from "#src/components/ui/empty";
import { useAppToast } from "#src/components/ui/toast";
import { copyText } from "#src/lib/clipboard";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { AnchorSurface, Anchoring } from "./attachment-anchoring";
import type { AttachmentCommentAnchor } from "./attachment-comment-anchors";
import { AttachmentCommentsPane } from "./attachment-comments";
import { AttachmentPreview } from "./attachment-preview";
import type { VideoHandoff, VideoPlace, VideoStart } from "./video-handoff";
import {
  TEXT_PREVIEW_MAX_BYTES,
  isTextPreviewKind,
  previewKindFor,
  takesComments,
} from "./attachment-preview-kind";
import { readPreviewText, type PreviewRead } from "./attachment-preview-text";
import { ImageLightbox, ReviewTitle, TOOLBAR_ICON } from "./image-lightbox";

type ReviewFile = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  previewUrl?: string;
  thumbnailUrl?: string;
  largeUrl?: string;
};

/**
 * An image's lightbox (`ImageLightbox`, the image alone), or a previewable file filling the screen
 * under an icon bar, its comments closed until asked for, as on Raft's page. A file that takes no
 * comments (`takesComments`: a PDF) has no comments button, and no note in its place, as on Raft.
 * A file without a preview never opens here: its card downloads it (`previewKindFor`).
 *
 * A text preview is read before the dialog opens, as in Raft: `children` (the card) shows
 * `loading` meanwhile. A file found to have no preview after all (past `TEXT_PREVIEW_MAX_BYTES`,
 * or no UTF-8 text) downloads instead of opening.
 */
export function AttachmentReviewDialog({
  file,
  children,
  videoHandoff,
}: {
  file: ReviewFile;
  children: (state: { loading: boolean }) => ReactNode;
  /** A video's player in the message: the preview carries on from its place, and back. */
  videoHandoff?: VideoHandoff;
}) {
  // Where the message's player was as the preview opened, and where the preview's is now: closing
  // hands that back, or the start again if the preview never got going (closed before it loaded,
  // or failed).
  const [videoStart, setVideoStart] = useState<VideoStart>();
  const videoPlace = useRef<VideoPlace | undefined>(undefined);
  // A preview opens on the file alone; on an HTML page showing the comments also marks regions.
  const [commentsExpanded, setCommentsExpanded] = useState(false);
  const [commentsOnPhone, setCommentsOnPhone] = useState(false);
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
  const kind = previewKindFor(file);
  const commentable = takesComments(file);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  // What reading the text preview found, once per card.
  const [read, setRead] = useState<PreviewRead | undefined>(undefined);
  const text = typeof read === "object" ? read.text : undefined;
  const reading = useRef<AbortController | null>(null);
  useEffect(() => () => reading.current?.abort(), []);
  const onOpenChange = (next: boolean) => {
    if (!next) {
      setOpen(false);
      setPendingAnchor(null);
      const place = videoPlace.current ?? videoStart?.place;
      if (place) videoHandoff?.give(place);
      return;
    }
    // A file found to have no preview after all (past the limit, or no text) downloads instead,
    // as one without a preview does from its card.
    if (read === "too-large" || read === "unavailable") return download(`${href}?download`);
    if (!isTextPreviewKind(kind) || read !== undefined) {
      // Only an opening preview takes the message's player's place (and pauses it).
      videoPlace.current = undefined;
      setVideoStart(videoHandoff?.take());
      return setOpen(true);
    }
    if (loading) return;
    setLoading(true);
    const controller = new AbortController();
    reading.current = controller;
    void readPreviewText(href, TEXT_PREVIEW_MAX_BYTES, controller.signal).then(
      (value) => {
        setRead(value);
        setLoading(false);
        if (typeof value === "object") setOpen(true);
        else download(`${href}?download`);
      },
      // Aborted: the card is gone.
      () => {},
    );
  };
  const commentsShown = commentsOnPhone || commentsExpanded;
  const toast = useAppToast();
  const copyLabel =
    kind === "markdown"
      ? m.attachment_preview_copy_markdown()
      : kind === "text"
        ? m.attachment_preview_copy()
        : null;
  if (file.contentType.startsWith("image/"))
    return (
      <DialogTrigger isOpen={open} onOpenChange={setOpen}>
        {children({ loading: false })}
        <ImageLightbox images={[file]} index={0} />
      </DialogTrigger>
    );
  return (
    <DialogTrigger isOpen={open} onOpenChange={onOpenChange}>
      {children({ loading })}
      <ModalOverlay
        isDismissable
        className="px-0 backdrop-blur-none sm:px-0 [--modal-pb:0px] [--modal-pt:0px] sm:[--modal-pb:0px] sm:[--modal-pt:0px]"
      >
        <Modal className="h-dvh max-h-dvh w-full rounded-none shadow-none max-sm:h-(--visual-viewport-height) max-sm:max-h-(--visual-viewport-height) max-sm:overflow-hidden sm:rounded-none">
          <Dialog aria-label={file.fileName} className="flex h-full flex-col overflow-hidden">
            {({ close }) => (
              <>
                <div className="flex h-14 shrink-0 items-center gap-1 border-b border-secondary bg-primary pr-2 pl-4">
                  <ReviewTitle fileName={file.fileName} contentType={file.contentType} />
                  {commentable && (
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
                  <div
                    className={cn(
                      "min-h-0 min-w-0 flex-1 flex-col overflow-auto lg:flex",
                      commentsOnPhone ? "hidden" : "flex",
                    )}
                  >
                    {kind ? (
                      <AttachmentPreview
                        fileName={file.fileName}
                        kind={kind}
                        href={href}
                        previewUrl={file.previewUrl}
                        text={text}
                        anchoring={anchoring}
                        commentsOpen={commentsExpanded}
                        pendingAnchor={pendingAnchor}
                        videoStart={videoStart}
                        onVideoPlace={(place) => (videoPlace.current = place)}
                      />
                    ) : (
                      <Empty>
                        <EmptyTitle>{m.attachment_comments_no_preview()}</EmptyTitle>
                      </Empty>
                    )}
                  </div>
                  {commentable && (
                    <div
                      className={cn(
                        "min-h-0 min-w-0 flex-1",
                        "lg:w-80 lg:flex-none lg:border-l lg:border-secondary",
                        commentsExpanded ? "lg:block" : "lg:hidden",
                        commentsOnPhone ? "block" : "hidden",
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
                  )}
                </div>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}

/**
 * Downloads by navigating to the `?download` address, which answers `Content-Disposition:
 * attachment`, so the page stays where it is. A navigation is not a pop-up: Safari lets it through
 * even after the asynchronous read, where it may block a synthetic link click.
 */
function download(href: string) {
  window.location.assign(href);
}

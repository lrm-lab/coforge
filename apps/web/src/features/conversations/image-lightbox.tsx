import { useEffect, useEffectEvent, useRef, useState, type MouseEvent } from "react";
import { ChevronLeft, ChevronRight, Download01, XClose } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { Empty, EmptyTitle } from "#src/components/ui/empty";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { takesComments } from "./attachment-preview-kind";
import { AttachmentCommentsPane } from "./attachment-comments";
import { LoadingImage } from "./loading-image";
import {
  ReviewCommentsColumn,
  ReviewCommentsToggle,
  reviewFileClass,
  useReviewComments,
} from "./review-comments";
import { ReviewTitle, TOOLBAR_ICON } from "./review-title";

export type LightboxImage = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  previewUrl?: string;
  thumbnailUrl?: string;
  largeUrl?: string;
};

/**
 * Moves focus from an arrow about to be disabled (it has reached the first or last image) to the
 * dialog: a disabled button drops focus to the page body, outside the dialog, where Escape no
 * longer reaches it.
 */
function keepFocusInside(arrow: HTMLElement) {
  arrow.closest<HTMLElement>('[role="dialog"]')?.focus();
}

/** Left and right arrow keys step through the images while the lightbox is open (mounted), except
 * in a text field (the comment being written), where they move the caret. */
function ArrowKeys({ onStep }: { onStep: (delta: -1 | 1) => void }) {
  const latest = useRef(onStep);
  latest.current = onStep;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable]")) return;
      if (event.key === "ArrowLeft") latest.current(-1);
      else if (event.key === "ArrowRight") latest.current(1);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return null;
}

/**
 * Raft's image lightbox over the dimmed page: a message's images one at a time, under a bar with
 * the file's type and name, "2 / 5", Download and Close. With several, arrows at either side and
 * the left and right keys step through them, stopping at the ends (the arrow there is disabled, as
 * on Raft), and a strip of thumbnails along the bottom jumps to one. A lone image shows none of
 * these. An image that fails to load says it has no preview, and Download still fetches it.
 *
 * The bar's comments button shows the image's comments beside it, as a file's review does (on a
 * phone, in its place), the image then on the review's opaque background; stepping to another image shows that one's. `commentsOpen` opens straight
 * at them, scrolled to `focusCommentId`: what a link into a comment asks for.
 *
 * Open state comes from the surrounding `DialogTrigger`, or from `isOpen`/`onOpenChange`.
 */
export function ImageLightbox({
  images,
  index,
  onIndexChange,
  isOpen,
  onOpenChange,
  commentsOpen,
  focusCommentId,
}: {
  images: readonly LightboxImage[];
  index: number;
  onIndexChange?: (index: number) => void;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  commentsOpen?: boolean;
  focusCommentId?: string;
}) {
  const image = images[index]!;
  return (
    <ModalOverlay
      isDismissable
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      className="bg-black/60 px-0 backdrop-blur-none sm:px-0 [--modal-pb:0px] [--modal-pt:0px] sm:[--modal-pb:0px] sm:[--modal-pt:0px]"
    >
      <Modal className="h-dvh max-h-dvh w-full rounded-none bg-transparent shadow-none max-sm:h-(--visual-viewport-height) max-sm:max-h-(--visual-viewport-height) max-sm:overflow-hidden sm:rounded-none">
        <Dialog aria-label={image.fileName} className="flex h-full flex-col overflow-hidden">
          {({ close }) => (
            <LightboxContent
              images={images}
              index={index}
              onIndexChange={onIndexChange}
              commentsOpen={commentsOpen}
              focusCommentId={focusCommentId}
              close={close}
            />
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/** The open lightbox: its bar, the image (with arrows and thumbnails when paged) and, asked for,
 * the image's comments. Mounted with each opening, so a link's `commentsOpen` holds for it. */
function LightboxContent({
  images,
  index,
  onIndexChange,
  commentsOpen,
  focusCommentId,
  close,
}: {
  images: readonly LightboxImage[];
  index: number;
  onIndexChange?: (index: number) => void;
  commentsOpen?: boolean;
  focusCommentId?: string;
  close: () => void;
}) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const comments = useReviewComments(commentsOpen);
  const image = images[index]!;
  const href = `/api/attachments/${image.id}`;
  const paged = images.length > 1 && onIndexChange !== undefined;
  const commentable = takesComments(image);
  // A link naming the image while the lightbox is already open shows its comments too.
  const showComments = useEffectEvent(comments.show);
  useEffect(() => {
    if (commentsOpen) showComments();
  }, [commentsOpen, image.id]);
  const step = (delta: -1 | 1) => {
    const next = index + delta;
    if (next >= 0 && next < images.length) onIndexChange?.(next);
  };
  return (
    <>
      {paged && <ArrowKeys onStep={step} />}
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-secondary bg-primary pr-2 pl-4">
        <ReviewTitle fileName={image.fileName} contentType={image.contentType} />
        {paged && (
          <span
            data-lightbox-position
            className="mx-2 shrink-0 rounded-md px-2 py-0.5 text-xs text-tertiary tabular-nums ring-1 ring-secondary ring-inset"
          >
            <span aria-hidden="true">
              {index + 1} / {images.length}
            </span>
            <span className="sr-only">
              {m.image_lightbox_position({ index: index + 1, count: images.length })}
            </span>
          </span>
        )}
        {commentable && <ReviewCommentsToggle comments={comments} />}
        <ButtonUtility
          icon={Download01}
          size="sm"
          color="tertiary"
          tooltip={m.attachment_preview_download({ name: image.fileName })}
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
        {/* Over the dimmed page alone; beside the comments, on the review's own background. */}
        <div className={cn(reviewFileClass(comments), comments.shown && "bg-secondary")}>
          <div className="relative flex min-h-0 flex-1 items-center justify-center p-4 sm:px-20">
            {failed.has(image.id) ? (
              <Empty className="rounded-xl bg-primary">
                <EmptyTitle>{m.attachment_comments_no_preview()}</EmptyTitle>
              </Empty>
            ) : (
              // The large tier over the thumbnail the message already showed until it
              // arrives; Download keeps the original. Keyed, so a new image starts afresh.
              <LoadingImage
                key={image.id}
                src={image.largeUrl ?? image.previewUrl ?? href}
                placeholderSrc={image.thumbnailUrl}
                fallbackSrc={image.largeUrl || image.previewUrl ? href : undefined}
                onFailed={() => setFailed((ids) => new Set(ids).add(image.id))}
                alt={image.fileName}
                className="flex size-full items-center justify-center"
                imgClassName="max-h-full max-w-full object-contain"
                skeletonClassName="m-auto size-[min(24rem,100%)]"
              />
            )}
            {paged && (
              <>
                <ButtonUtility
                  icon={ChevronLeft}
                  size="sm"
                  tooltip={m.image_lightbox_previous()}
                  isDisabled={index === 0}
                  className="absolute top-1/2 left-2 -translate-y-1/2 sm:left-8"
                  onClick={(event: MouseEvent<HTMLElement>) => {
                    if (index - 1 === 0) keepFocusInside(event.currentTarget);
                    step(-1);
                  }}
                />
                <ButtonUtility
                  icon={ChevronRight}
                  size="sm"
                  tooltip={m.image_lightbox_next()}
                  isDisabled={index === images.length - 1}
                  className="absolute top-1/2 right-2 -translate-y-1/2 sm:right-8"
                  onClick={(event: MouseEvent<HTMLElement>) => {
                    if (index + 1 === images.length - 1) keepFocusInside(event.currentTarget);
                    step(1);
                  }}
                />
              </>
            )}
          </div>
          {paged && (
            <div
              data-lightbox-thumbnails
              className="flex shrink-0 justify-center gap-1.5 overflow-x-auto px-4 pt-1 pb-4"
            >
              {images.map((thumbnail, position) => (
                <Button
                  key={thumbnail.id}
                  color="tertiary"
                  noTextPadding
                  aria-label={thumbnail.fileName}
                  aria-current={position === index || undefined}
                  onClick={() => onIndexChange?.(position)}
                  className={cn(
                    "size-12 shrink-0 overflow-hidden rounded-sm border-2 p-0 hover:bg-transparent [&>span]:block [&>span]:size-full",
                    position === index
                      ? "border-brand"
                      : "border-transparent opacity-60 hover:opacity-100",
                  )}
                >
                  <LoadingImage
                    src={
                      thumbnail.thumbnailUrl ??
                      thumbnail.previewUrl ??
                      `/api/attachments/${thumbnail.id}`
                    }
                    alt=""
                    className="size-full"
                    imgClassName="block size-full object-cover"
                  />
                </Button>
              ))}
            </div>
          )}
        </div>
        {commentable && (
          <ReviewCommentsColumn comments={comments}>
            <AttachmentCommentsPane
              key={image.id}
              attachmentId={image.id}
              fileName={image.fileName}
              focusCommentId={focusCommentId}
            />
          </ReviewCommentsColumn>
        )}
      </div>
    </>
  );
}

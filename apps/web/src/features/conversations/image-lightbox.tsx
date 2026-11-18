import { useEffect, useEffectEvent, useState, type MouseEvent } from "react";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { ChevronLeft, ChevronRight, Download01, XClose } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { Empty, EmptyTitle } from "#src/components/ui/empty";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { takesComments } from "./attachment-preview-kind";
import { AttachmentCommentsPane } from "./attachment-comments";
import { lightboxStepTarget } from "./image-lightbox-step";
import { LoadingImage } from "./loading-image";
import {
  ReviewCommentsColumn,
  ReviewCommentsToggle,
  reviewFileClass,
  useReviewComments,
} from "./review-comments";
import { PANEL_HEADER_CLASS } from "./review-chrome";
import { ReviewTitle } from "./review-title";

export type LightboxImage = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  previewUrl?: string;
  thumbnailUrl?: string;
  largeUrl?: string;
};

function keepFocusInside(arrow: HTMLElement) {
  arrow.closest<HTMLElement>('[role="dialog"]')?.focus();
}

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
        <Dialog
          aria-label={image.fileName}
          className="flex h-full flex-col overflow-hidden safe-area-padding"
        >
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
  const showComments = useEffectEvent(comments.show);
  useEffect(() => {
    if (commentsOpen) showComments();
  }, [commentsOpen, image.id]);
  const step = (delta: -1 | 1) => {
    const next = lightboxStepTarget(index, delta, images.length);
    if (next !== undefined) onIndexChange?.(next);
  };
  useHotkeys(
    [
      { hotkey: "ArrowLeft", callback: () => step(-1) },
      { hotkey: "ArrowRight", callback: () => step(1) },
    ],
    { enabled: paged },
  );
  return (
    <>
      <div className={cn(PANEL_HEADER_CLASS, "bg-primary")}>
        <ReviewTitle fileName={image.fileName} contentType={image.contentType} />
        {paged && (
          <span data-lightbox-position className="mx-2 shrink-0 text-xs text-tertiary tabular-nums">
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
          size="xs"
          color="tertiary"
          tooltip={m.attachment_preview_download({ name: image.fileName })}
          href={`${href}?download`}
        />
        <ButtonUtility
          icon={XClose}
          size="xs"
          color="tertiary"
          tooltip={m.controls_close()}
          onClick={close}
        />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className={cn(reviewFileClass(comments), comments.shown && "bg-secondary")}>
          <div className="relative flex min-h-0 flex-1 items-center justify-center p-4 sm:px-20">
            {failed.has(image.id) ? (
              <Empty className="rounded-xl bg-primary">
                <EmptyTitle>{m.attachment_comments_no_preview()}</EmptyTitle>
              </Empty>
            ) : (
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

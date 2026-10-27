import { useEffect, useRef, useState, type MouseEvent } from "react";
import { ChevronLeft, ChevronRight, Download01, XClose } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { Empty, EmptyTitle } from "#src/components/ui/empty";
import { fileTypeLabel } from "#src/features/files/file-meta";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { LoadingImage } from "./loading-image";

export type LightboxImage = {
  id: string;
  fileName: string;
  contentType: string;
  previewUrl?: string;
  thumbnailUrl?: string;
  largeUrl?: string;
};

// The icon bar is drawn at full text color, as on Raft; the tertiary gray reads as disabled.
export const TOOLBAR_ICON = "text-fg-primary hover:text-fg-primary";

/** A file's type tag and name, the title of the bar over a preview or an image. */
export function ReviewTitle({ fileName, contentType }: { fileName: string; contentType: string }) {
  const typeLabel = fileTypeLabel(fileName, contentType);
  return (
    <p className="flex min-w-0 flex-1 items-center gap-2">
      {typeLabel && (
        <span className="shrink-0 rounded-sm bg-secondary px-1 py-0.5 text-xs leading-none font-semibold text-tertiary ring-1 ring-secondary ring-inset">
          {typeLabel}
        </span>
      )}
      <span className="truncate text-sm font-semibold text-primary">{fileName}</span>
    </p>
  );
}

/**
 * Moves focus from an arrow about to be disabled (it has reached the first or last image) to the
 * dialog: a disabled button drops focus to the page body, outside the dialog, where Escape no
 * longer reaches it.
 */
function keepFocusInside(arrow: HTMLElement) {
  arrow.closest<HTMLElement>('[role="dialog"]')?.focus();
}

/** Left and right arrow keys step through the images while the lightbox is open (mounted). */
function ArrowKeys({ onStep }: { onStep: (delta: -1 | 1) => void }) {
  const latest = useRef(onStep);
  latest.current = onStep;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
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
 * Open state comes from the surrounding `DialogTrigger`, or from `isOpen`/`onOpenChange`.
 */
export function ImageLightbox({
  images,
  index,
  onIndexChange,
  isOpen,
  onOpenChange,
}: {
  images: readonly LightboxImage[];
  index: number;
  onIndexChange?: (index: number) => void;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const image = images[index]!;
  const href = `/api/attachments/${image.id}`;
  const paged = images.length > 1 && onIndexChange !== undefined;
  const step = (delta: -1 | 1) => {
    const next = index + delta;
    if (next >= 0 && next < images.length) onIndexChange?.(next);
  };
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
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

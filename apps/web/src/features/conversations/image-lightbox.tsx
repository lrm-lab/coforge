import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { ChevronLeft, ChevronRight, Download01, XClose } from "@untitledui/icons";
import type { ReactZoomPanPinchContentRef } from "react-zoom-pan-pinch";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { Empty, EmptyTitle } from "#src/components/ui/empty";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import {
  animateFlipFromRect,
  animateFlipToRect,
  cancelFlipAnimation,
  type SharedRect,
} from "#src/lib/shared-element-rect";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { takesComments } from "./attachment-preview-kind";
import { AttachmentCommentsPane } from "./attachment-comments";
import { LightboxZoomStage, ZOOM_SCALE_EPSILON } from "./image-lightbox-stage";
import { lightboxStepTarget } from "./image-lightbox-step";
import {
  LightboxZoomFooterBar,
  LightboxZoomHeaderControls,
  keepFocusInside,
} from "./image-lightbox-zoom-controls";
import { LoadingImage } from "./loading-image";
import { ReviewCommentsToggle, ReviewSplitLayout, useReviewComments } from "./review-comments";
import { PANEL_HEADER_CLASS } from "./review-chrome";
import { ReviewTitle } from "./review-title";
import {
  KEYBOARD_PAN_STEP_PX,
  MIN_ZOOM_SCALE,
  ZOOM_ANIMATION_MS,
  ZOOM_STEP,
  formatZoomPercent,
  useLightboxDismissSwipe,
} from "./use-lightbox-dismiss-swipe";

export type LightboxImage = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  previewUrl?: string;
  thumbnailUrl?: string;
  largeUrl?: string;
};

export function ImageLightbox({
  images,
  index,
  onIndexChange,
  isOpen,
  onOpenChange,
  commentsOpen,
  focusCommentId,
  getOriginRect,
}: {
  images: readonly LightboxImage[];
  index: number;
  onIndexChange?: (index: number) => void;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  commentsOpen?: boolean;
  focusCommentId?: string;
  getOriginRect?: (imageId: string) => SharedRect | null;
}) {
  const image = images[index]!;
  const reduced = usePrefersReducedMotion();
  const desktop = useBreakpoint("sm");
  const hasOrigin = !reduced && Boolean(getOriginRect?.(image.id));
  const [closing, setClosing] = useState(false);
  const [dragProgress, setDragProgress] = useState(0);
  const closingRef = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const zoomedRef = useRef(false);

  const finishClose = useCallback(() => {
    closingRef.current = false;
    setClosing(false);
    setDragProgress(0);
    onOpenChange?.(false);
  }, [onOpenChange]);

  const requestClose = useCallback(
    (fromTransform?: string) => {
      if (closingRef.current) {
        finishClose();
        return;
      }
      const origin = reduced ? null : (getOriginRect?.(image.id) ?? null);
      const img = stageRef.current?.querySelector<HTMLElement>("img");
      if (zoomedRef.current || !origin || !img) {
        finishClose();
        return;
      }
      closingRef.current = true;
      setClosing(true);
      const duration = desktop ? 260 : 380;
      const animation = animateFlipToRect(img, origin, {
        duration,
        mode: "uniform",
        includeRadius: true,
        fromTransform,
      });
      if (!animation) {
        finishClose();
        return;
      }
      animation.addEventListener("finish", finishClose, { once: true });
      animation.addEventListener("cancel", finishClose, { once: true });
    },
    [desktop, finishClose, getOriginRect, image.id, reduced],
  );

  return (
    <ModalOverlay
      isDismissable
      isOpen={isOpen}
      onOpenChange={(next) => {
        if (next) onOpenChange?.(true);
        else requestClose();
      }}
      className="bg-transparent px-0 backdrop-blur-none sm:px-0 [--modal-pb:0px] [--modal-pt:0px] sm:[--modal-pb:0px] sm:[--modal-pt:0px]"
    >
      <Modal
        className={cn(
          "relative h-dvh max-h-dvh w-full rounded-none bg-transparent shadow-none max-sm:h-(--visual-viewport-height) max-sm:max-h-(--visual-viewport-height) max-sm:overflow-hidden sm:rounded-none",
          hasOrigin && "animate-none",
        )}
      >
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 transition-opacity",
            closing && "opacity-0",
          )}
          style={{
            backgroundColor:
              dragProgress > 0
                ? `rgb(0 0 0 / ${Math.max(0.08, 0.6 * (1 - dragProgress * 0.85))})`
                : "rgb(0 0 0 / 0.6)",
            transitionDuration: closing
              ? desktop
                ? "var(--duration-md-out)"
                : "var(--duration-lg-out)"
              : "var(--duration-sm-out)",
            transitionTimingFunction: closing ? "var(--ease-in)" : "var(--ease-out)",
          }}
        />
        <Dialog
          aria-label={image.fileName}
          className="relative z-1 flex h-full flex-col overflow-hidden safe-area-padding"
        >
          <LightboxContent
            images={images}
            index={index}
            onIndexChange={onIndexChange}
            commentsOpen={commentsOpen}
            focusCommentId={focusCommentId}
            close={() => requestClose()}
            requestDragClose={requestClose}
            getOriginRect={getOriginRect}
            stageRef={stageRef}
            zoomedRef={zoomedRef}
            closing={closing}
            desktop={desktop}
            reduced={reduced}
            onDragProgress={setDragProgress}
          />
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
  requestDragClose,
  getOriginRect,
  stageRef,
  zoomedRef,
  closing,
  desktop,
  reduced,
  onDragProgress,
}: {
  images: readonly LightboxImage[];
  index: number;
  onIndexChange?: (index: number) => void;
  commentsOpen?: boolean;
  focusCommentId?: string;
  close: () => void;
  requestDragClose: (fromTransform?: string) => void;
  getOriginRect?: (imageId: string) => SharedRect | null;
  stageRef: React.RefObject<HTMLDivElement | null>;
  zoomedRef: React.RefObject<boolean>;
  closing: boolean;
  desktop: boolean;
  reduced: boolean;
  onDragProgress: (progress: number) => void;
}) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [chromeVisible, setChromeVisible] = useState(() => reduced || !getOriginRect);
  const [displayScale, setDisplayScale] = useState(MIN_ZOOM_SCALE);
  const [isPanning, setIsPanning] = useState(false);
  const comments = useReviewComments(commentsOpen);
  const image = images[index]!;
  const href = `/api/attachments/${image.id}`;
  const paged = images.length > 1 && onIndexChange !== undefined;
  const commentable = takesComments(image);
  const isFailed = failed.has(image.id);
  const isZoomed = displayScale > MIN_ZOOM_SCALE + ZOOM_SCALE_EPSILON;
  const didEntrance = useRef(false);
  const zoomRef = useRef<ReactZoomPanPinchContentRef>(null);

  useEffect(() => {
    setDisplayScale(MIN_ZOOM_SCALE);
    zoomedRef.current = false;
    setIsPanning(false);
  }, [image.id, zoomedRef]);

  const step = useCallback(
    (delta: -1 | 1) => {
      const next = lightboxStepTarget(index, delta, images.length);
      if (next !== undefined) onIndexChange?.(next);
    },
    [images.length, index, onIndexChange],
  );

  const zoomDuration = useCallback(
    (instant = false) => (instant || reduced ? 0 : ZOOM_ANIMATION_MS),
    [reduced],
  );

  const zoomIn = useCallback(
    (instant = false) => {
      zoomRef.current?.zoomIn(ZOOM_STEP, zoomDuration(instant));
    },
    [zoomDuration],
  );

  const zoomOut = useCallback(
    (instant = false) => {
      const instance = zoomRef.current;
      if (!instance) return;
      const ms = zoomDuration(instant);
      if (instance.state.scale - ZOOM_STEP <= MIN_ZOOM_SCALE + 0.05) {
        instance.resetTransform(ms);
        return;
      }
      instance.zoomOut(ZOOM_STEP, ms);
    },
    [zoomDuration],
  );

  const resetZoom = useCallback(
    (instant = false) => {
      zoomRef.current?.resetTransform(zoomDuration(instant));
    },
    [zoomDuration],
  );

  const panBy = useCallback((dx: number, dy: number) => {
    zoomRef.current?.panBy(dx, dy, 0);
  }, []);

  const { onStagePointerDown, onStagePointerMove, onStagePointerEnd } = useLightboxDismissSwipe({
    stageRef,
    zoomedRef,
    imageId: image.id,
    index,
    imageCount: images.length,
    paged,
    failed: isFailed,
    closing,
    commentsShown: comments.shown,
    reduced,
    onDragProgress,
    onRequestDragClose: requestDragClose,
    onStep: step,
  });

  useLayoutEffect(() => {
    if (didEntrance.current) {
      setChromeVisible(true);
      return;
    }
    didEntrance.current = true;
    if (reduced) {
      setChromeVisible(true);
      return;
    }
    const origin = getOriginRect?.(image.id) ?? null;
    const img = stageRef.current?.querySelector<HTMLElement>("img");
    if (!origin || !img) {
      setChromeVisible(true);
      return;
    }
    const duration = desktop ? 300 : 450;
    animateFlipFromRect(img, origin, {
      duration,
      mode: "uniform",
      includeRadius: true,
    });
    const timer = window.setTimeout(() => setChromeVisible(true), Math.round(duration * 0.45));
    return () => {
      window.clearTimeout(timer);
      cancelFlipAnimation(img);
    };
  }, [desktop, getOriginRect, image.id, reduced, stageRef]);

  const showComments = useEffectEvent(comments.show);
  useEffect(() => {
    if (commentsOpen) showComments();
  }, [commentsOpen, image.id]);

  useHotkeys(
    [
      {
        hotkey: "ArrowLeft",
        callback: () => (zoomedRef.current ? panBy(KEYBOARD_PAN_STEP_PX, 0) : step(-1)),
      },
      {
        hotkey: "ArrowRight",
        callback: () => (zoomedRef.current ? panBy(-KEYBOARD_PAN_STEP_PX, 0) : step(1)),
      },
    ],
    { enabled: !isFailed && !closing && (paged || isZoomed), ignoreInputs: true },
  );
  useHotkeys(
    [
      { hotkey: "ArrowUp", callback: () => panBy(0, KEYBOARD_PAN_STEP_PX) },
      { hotkey: "ArrowDown", callback: () => panBy(0, -KEYBOARD_PAN_STEP_PX) },
    ],
    { enabled: !isFailed && !closing && isZoomed, ignoreInputs: true },
  );
  useHotkeys(
    [
      { hotkey: "+", callback: () => zoomIn(true) },
      { hotkey: "=", callback: () => zoomIn(true) },
      { hotkey: "-", callback: () => zoomOut(true) },
      { hotkey: "_", callback: () => zoomOut(true) },
      { hotkey: "0", callback: () => resetZoom(true) },
    ],
    { enabled: !isFailed && !closing, ignoreInputs: true },
  );

  const chromeHidden = closing || !chromeVisible;

  return (
    <>
      <div
        className={cn(
          PANEL_HEADER_CLASS,
          "bg-primary transition-opacity duration-150",
          chromeHidden && "pointer-events-none opacity-0",
        )}
      >
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
        {!isFailed && (
          <LightboxZoomHeaderControls
            scale={displayScale}
            onZoomIn={() => zoomIn(false)}
            onZoomOut={() => zoomOut(false)}
            onReset={() => resetZoom(false)}
          />
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
      <ReviewSplitLayout
        comments={comments}
        commentable={commentable}
        fileClassName={comments.shown ? "bg-secondary" : undefined}
        file={
          <>
            <div
              ref={stageRef}
              data-lightbox-stage=""
              data-zoom-scale={formatZoomPercent(displayScale)}
              onPointerDown={onStagePointerDown}
              onPointerMove={onStagePointerMove}
              onPointerUp={onStagePointerEnd}
              onPointerCancel={onStagePointerEnd}
              className={cn(
                "relative flex min-h-0 flex-1 touch-none items-center justify-center select-none",
                isZoomed ? "overflow-hidden" : "overflow-visible",
                !isFailed && isZoomed && (isPanning ? "cursor-grabbing" : "cursor-grab"),
              )}
            >
              {isFailed ? (
                <Empty className="rounded-xl bg-primary">
                  <EmptyTitle>{m.attachment_comments_no_preview()}</EmptyTitle>
                </Empty>
              ) : (
                <LightboxZoomStage
                  imageId={image.id}
                  src={image.largeUrl ?? image.previewUrl ?? href}
                  placeholderSrc={image.thumbnailUrl}
                  fallbackSrc={image.largeUrl || image.previewUrl ? href : undefined}
                  fileName={image.fileName}
                  zoomRef={zoomRef}
                  zoomedRef={zoomedRef}
                  isZoomed={isZoomed}
                  reduced={reduced}
                  onPanningChange={setIsPanning}
                  onScaleChange={setDisplayScale}
                  onFailed={() => setFailed((ids) => new Set(ids).add(image.id))}
                />
              )}
              {paged && !isZoomed && (
                <>
                  <ButtonUtility
                    icon={ChevronLeft}
                    size="sm"
                    tooltip={m.image_lightbox_previous()}
                    isDisabled={index === 0}
                    className={cn(
                      "absolute top-1/2 left-2 -translate-y-1/2 transition-opacity duration-150 sm:left-8",
                      chromeHidden && "pointer-events-none opacity-0",
                    )}
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
                    className={cn(
                      "absolute top-1/2 right-2 -translate-y-1/2 transition-opacity duration-150 sm:right-8",
                      chromeHidden && "pointer-events-none opacity-0",
                    )}
                    onClick={(event: MouseEvent<HTMLElement>) => {
                      if (index + 1 === images.length - 1) keepFocusInside(event.currentTarget);
                      step(1);
                    }}
                  />
                </>
              )}
            </div>
            {!isFailed && (
              <LightboxZoomFooterBar
                scale={displayScale}
                paged={paged}
                chromeHidden={chromeHidden}
                onZoomIn={() => zoomIn(false)}
                onZoomOut={() => zoomOut(false)}
                onReset={() => resetZoom(false)}
              />
            )}
            {paged && (
              <div
                data-lightbox-thumbnails
                className={cn(
                  "flex shrink-0 justify-center gap-1.5 overflow-x-auto px-4 pt-1 pb-4 transition-opacity duration-150",
                  chromeHidden && "pointer-events-none opacity-0",
                )}
              >
                {images.map((thumbnail, position) => (
                  <Button
                    key={thumbnail.id}
                    color="tertiary"
                    noTextPadding
                    aria-label={thumbnail.fileName}
                    aria-current={position === index || undefined}
                    onPress={() => onIndexChange?.(position)}
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
        }
        commentsPane={
          commentable ? (
            <AttachmentCommentsPane
              key={image.id}
              attachmentId={image.id}
              fileName={image.fileName}
              focusCommentId={focusCommentId}
            />
          ) : undefined
        }
      />
    </>
  );
}

import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  TransformComponent,
  TransformWrapper,
  type ReactZoomPanPinchContentRef,
} from "react-zoom-pan-pinch";
import "react-zoom-pan-pinch/dist/styles.css";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import {
  SHARE_ZOOM_DEFAULT_SCALE,
  SHARE_ZOOM_EPSILON,
  SHARE_ZOOM_MAX_SCALE,
  isShareOverviewActive,
} from "./message-share-image-model";
import { ZOOM_ANIMATION_MS, formatZoomPercent } from "./use-lightbox-dismiss-swipe";

export function ShareZoomStage({
  page,
  alt,
  zoomRef,
  reduced,
  desktop,
  stageSize,
  overviewScale,
  canOverview,
  displayScale,
  isPanning,
  onScaleChange,
  onPanningChange,
}: {
  page: { url: string; width: number; height: number };
  alt: string;
  zoomRef: RefObject<ReactZoomPanPinchContentRef | null>;
  reduced: boolean;
  desktop: boolean;
  stageSize: { width: number; height: number };
  overviewScale: number;
  canOverview: boolean;
  displayScale: number;
  isPanning: boolean;
  onScaleChange: Dispatch<SetStateAction<number>>;
  onPanningChange: (panning: boolean) => void;
}) {
  const pad = desktop ? 24 : 16;
  const baseWidth = Math.min(page.width, Math.max(160, stageSize.width - pad));
  const baseHeight = Math.max(1, Math.round(baseWidth * (page.height / page.width)));
  const isOverview = isShareOverviewActive(displayScale, overviewScale);
  const isZoomedIn = displayScale > SHARE_ZOOM_DEFAULT_SCALE + SHARE_ZOOM_EPSILON;
  const canPan = isZoomedIn || (canOverview && !isOverview);

  return (
    <div className="relative size-full">
      <TransformWrapper
        key={`${page.url}-${Math.round(baseWidth)}`}
        ref={zoomRef}
        initialScale={SHARE_ZOOM_DEFAULT_SCALE}
        minScale={canOverview ? overviewScale : SHARE_ZOOM_DEFAULT_SCALE}
        maxScale={SHARE_ZOOM_MAX_SCALE}
        initialPositionX="center"
        initialPositionY={canOverview ? "top" : "center"}
        limitToBounds
        centerZoomedOut
        wheel={{ wheelDisabled: true, touchPadDisabled: false, step: 0.004 }}
        trackPadPanning={{ disabled: !canPan, velocityDisabled: reduced }}
        panning={{ disabled: !canPan, velocityDisabled: reduced }}
        pinch={{ step: 5 }}
        doubleClick={{
          mode: "toggle",
          step: 1,
          animationTime: reduced ? 0 : ZOOM_ANIMATION_MS,
        }}
        zoomAnimation={{
          disabled: reduced,
          animationTime: reduced ? 0 : ZOOM_ANIMATION_MS,
        }}
        autoAlignment={{
          animationTime: reduced ? 0 : 200,
          velocityAlignmentTime: reduced ? 0 : 300,
        }}
        velocityAnimation={{
          disabled: reduced,
        }}
        onPanningStart={() => onPanningChange(true)}
        onPanningStop={() => onPanningChange(false)}
        onTransform={(_ref, state) => {
          const normalized =
            Math.abs(state.scale - SHARE_ZOOM_DEFAULT_SCALE) <= 0.008
              ? SHARE_ZOOM_DEFAULT_SCALE
              : state.scale;
          onScaleChange((prev) => {
            const samePct = Math.round(prev * 100) === Math.round(normalized * 100);
            const sameOverview =
              isShareOverviewActive(prev, overviewScale) ===
              isShareOverviewActive(normalized, overviewScale);
            const sameZoomed =
              prev > SHARE_ZOOM_DEFAULT_SCALE + SHARE_ZOOM_EPSILON ===
              normalized > SHARE_ZOOM_DEFAULT_SCALE + SHARE_ZOOM_EPSILON;
            return samePct && sameOverview && sameZoomed ? prev : normalized;
          });
        }}
      >
        <TransformComponent
          disableStyleInjection
          wrapperClass={cn(
            "size-full! overscroll-contain",
            canPan || isOverview ? "touch-none" : "touch-manipulation",
            canPan && (isPanning ? "cursor-grabbing" : "cursor-grab"),
          )}
          wrapperStyle={{
            width: "100%",
            height: "100%",
            overflow: "hidden",
          }}
        >
          <div className="p-2 sm:p-3">
            <div style={{ width: baseWidth, height: baseHeight }}>
              <img
                src={page.url}
                alt={alt}
                width={page.width}
                height={page.height}
                className="block size-full select-none shadow-xs ring-1 ring-secondary [-webkit-user-drag:none]"
              />
            </div>
          </div>
        </TransformComponent>
      </TransformWrapper>
      {(isOverview || isZoomedIn) && (
        <span
          data-share-zoom-pill=""
          aria-live="polite"
          className="pointer-events-none absolute right-3 bottom-3 z-10 rounded-full bg-primary/90 px-2.5 py-1 text-xs font-medium text-secondary shadow-xs ring-1 ring-secondary ring-inset backdrop-blur-md tabular-nums motion-reduce:backdrop-blur-none"
        >
          {isOverview
            ? m.message_share_zoom_overview_badge({ percent: formatZoomPercent(displayScale) })
            : formatZoomPercent(displayScale)}
        </span>
      )}
    </div>
  );
}

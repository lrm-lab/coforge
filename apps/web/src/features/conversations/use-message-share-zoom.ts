import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useHotkeys } from "@tanstack/react-hotkeys";
import type { ReactZoomPanPinchContentRef } from "react-zoom-pan-pinch";
import {
  SHARE_ZOOM_DEFAULT_SCALE,
  SHARE_ZOOM_EPSILON,
  canShareOverview,
  isShareOverviewActive,
  shareOverviewScale,
  shareZoomStepTarget,
} from "./message-share-image-model";
import { KEYBOARD_PAN_STEP_PX, ZOOM_ANIMATION_MS } from "./use-lightbox-dismiss-swipe";

export function useMessageShareZoom({
  page,
  fallbackWidth,
  desktop,
  reduced,
  stepName,
  index,
  total,
  onIndexChange,
}: {
  page: { url: string; width: number; height: number } | undefined;
  fallbackWidth: number;
  desktop: boolean;
  reduced: boolean;
  stepName: string;
  index: number;
  total: number;
  onIndexChange: (nextIndex: number) => void;
}) {
  const stageContainerRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<ReactZoomPanPinchContentRef>(null);
  const [displayScale, setDisplayScale] = useState(SHARE_ZOOM_DEFAULT_SCALE);
  const [isPanning, setIsPanning] = useState(false);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const node = stageContainerRef.current;
    if (!node) return;
    const measure = () => {
      const nextW = node.clientWidth;
      const nextH = node.clientHeight;
      setStageSize((prev) =>
        prev.width === nextW && prev.height === nextH ? prev : { width: nextW, height: nextH },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [stepName, index]);

  const pad = desktop ? 24 : 16;
  const measuredStageWidth = stageSize.width > 0 ? stageSize.width : fallbackWidth;
  const measuredStageHeight = stageSize.height > 0 ? stageSize.height : 420;
  const baseWidth = page
    ? Math.min(page.width, Math.max(160, measuredStageWidth - pad))
    : fallbackWidth;
  const baseHeight = page ? Math.max(1, Math.round(baseWidth * (page.height / page.width))) : 240;
  const preferredStageHeight = page ? Math.max(200, Math.round(baseHeight + pad)) : undefined;
  const overviewScale = page
    ? shareOverviewScale(measuredStageWidth, measuredStageHeight, baseWidth + pad, baseHeight + pad)
    : SHARE_ZOOM_DEFAULT_SCALE;
  const canOverview = canShareOverview(overviewScale);
  const isOverview = isShareOverviewActive(displayScale, overviewScale);
  const isZoomedIn = displayScale > SHARE_ZOOM_DEFAULT_SCALE + SHARE_ZOOM_EPSILON;
  const canPan = isZoomedIn || (canOverview && !isOverview);

  useEffect(() => {
    setDisplayScale(SHARE_ZOOM_DEFAULT_SCALE);
    setIsPanning(false);
  }, [page?.url]);

  const zoomDuration = useCallback(
    (instant = false) => (instant || reduced ? 0 : ZOOM_ANIMATION_MS),
    [reduced],
  );

  const stepZoom = useCallback(
    (direction: "in" | "out", instant = false) => {
      const instance = zoomRef.current;
      if (!instance) return;
      const ms = zoomDuration(instant);
      const target = shareZoomStepTarget(instance.state.scale, direction, overviewScale);
      if (target.mode === "reset") {
        instance.resetTransform(ms);
        return;
      }
      if (target.mode === "overview") {
        instance.fitToView({
          mode: "contain",
          minScale: overviewScale,
          maxScale: SHARE_ZOOM_DEFAULT_SCALE,
          animationTime: ms,
        });
        return;
      }
      if (direction === "in") {
        instance.zoomIn(Math.max(0.01, target.scale - instance.state.scale), ms);
      } else {
        instance.zoomOut(Math.max(0.01, instance.state.scale - target.scale), ms);
      }
    },
    [overviewScale, zoomDuration],
  );

  const resetZoom = useCallback(
    (instant = false) => {
      zoomRef.current?.resetTransform(zoomDuration(instant));
    },
    [zoomDuration],
  );

  const toggleOverview = useCallback(() => {
    const instance = zoomRef.current;
    if (!instance || !canOverview) return;
    const ms = zoomDuration();
    if (isShareOverviewActive(instance.state.scale, overviewScale)) {
      instance.resetTransform(ms);
      return;
    }
    instance.fitToView({
      mode: "contain",
      minScale: overviewScale,
      maxScale: SHARE_ZOOM_DEFAULT_SCALE,
      animationTime: ms,
    });
  }, [canOverview, overviewScale, zoomDuration]);

  const panBy = useCallback((dx: number, dy: number) => {
    zoomRef.current?.panBy(dx, dy, 0);
  }, []);

  useHotkeys(
    [
      { hotkey: "+", callback: () => stepZoom("in", true) },
      { hotkey: "=", callback: () => stepZoom("in", true) },
      { hotkey: "-", callback: () => stepZoom("out", true) },
      { hotkey: "_", callback: () => stepZoom("out", true) },
      { hotkey: "0", callback: () => resetZoom(true) },
    ],
    { enabled: Boolean(page), ignoreInputs: true },
  );

  useHotkeys(
    [
      { hotkey: "ArrowUp", callback: () => panBy(0, KEYBOARD_PAN_STEP_PX) },
      { hotkey: "ArrowDown", callback: () => panBy(0, -KEYBOARD_PAN_STEP_PX) },
    ],
    { enabled: Boolean(page) && canPan, ignoreInputs: true },
  );

  useHotkeys(
    [
      {
        hotkey: "ArrowLeft",
        callback: () =>
          isZoomedIn ? panBy(KEYBOARD_PAN_STEP_PX, 0) : index > 0 && onIndexChange(index - 1),
      },
      {
        hotkey: "ArrowRight",
        callback: () =>
          isZoomedIn
            ? panBy(-KEYBOARD_PAN_STEP_PX, 0)
            : index + 1 < total && onIndexChange(index + 1),
      },
    ],
    { enabled: Boolean(page) && (isZoomedIn || total > 1), ignoreInputs: true },
  );

  return {
    stageContainerRef,
    zoomRef,
    displayScale,
    setDisplayScale,
    isPanning,
    setIsPanning,
    measuredStageSize: { width: measuredStageWidth, height: measuredStageHeight },
    preferredStageHeight,
    overviewScale,
    canOverview,
    isOverview,
    stepZoom,
    resetZoom,
    toggleOverview,
  };
}

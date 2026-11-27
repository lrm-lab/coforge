import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  TransformComponent,
  TransformWrapper,
  type ReactZoomPanPinchContentRef,
} from "react-zoom-pan-pinch";
import "react-zoom-pan-pinch/dist/styles.css";
import { LoadingImage } from "./loading-image";
import {
  DOUBLE_TAP_ZOOM_STEP,
  MAX_ZOOM_SCALE,
  MIN_ZOOM_SCALE,
  ZOOM_ANIMATION_MS,
} from "./use-lightbox-dismiss-swipe";

export const ZOOM_SCALE_EPSILON = 0.005;

export function LightboxZoomStage({
  imageId,
  src,
  placeholderSrc,
  fallbackSrc,
  fileName,
  zoomRef,
  zoomedRef,
  isZoomed,
  reduced,
  onPanningChange,
  onScaleChange,
  onFailed,
}: {
  imageId: string;
  src: string;
  placeholderSrc?: string;
  fallbackSrc?: string;
  fileName: string;
  zoomRef: RefObject<ReactZoomPanPinchContentRef | null>;
  zoomedRef: RefObject<boolean>;
  isZoomed: boolean;
  reduced: boolean;
  onPanningChange: (panning: boolean) => void;
  onScaleChange: Dispatch<SetStateAction<number>>;
  onFailed: () => void;
}) {
  return (
    <TransformWrapper
      key={imageId}
      ref={zoomRef}
      initialScale={MIN_ZOOM_SCALE}
      minScale={MIN_ZOOM_SCALE}
      maxScale={MAX_ZOOM_SCALE}
      centerOnInit
      centerZoomedOut
      limitToBounds
      wheel={{ step: 0.004 }}
      pinch={{ step: 5 }}
      doubleClick={{
        mode: "toggle",
        step: DOUBLE_TAP_ZOOM_STEP,
        animationTime: reduced ? 0 : ZOOM_ANIMATION_MS,
      }}
      panning={{
        disabled: !isZoomed,
        velocityDisabled: reduced,
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
        const nextScale =
          state.scale <= MIN_ZOOM_SCALE + ZOOM_SCALE_EPSILON ? MIN_ZOOM_SCALE : state.scale;
        zoomedRef.current = nextScale > MIN_ZOOM_SCALE;
        onScaleChange((prev) =>
          Math.round(prev * 100) === Math.round(nextScale * 100) &&
          prev > MIN_ZOOM_SCALE === nextScale > MIN_ZOOM_SCALE
            ? prev
            : nextScale,
        );
      }}
    >
      <TransformComponent
        disableStyleInjection
        wrapperClass="size-full!"
        contentClass="size-full! flex! items-center! justify-center! p-4 sm:px-20"
        wrapperStyle={{
          width: "100%",
          height: "100%",
          overflow: isZoomed ? "hidden" : "visible",
        }}
        contentStyle={{ width: "100%", height: "100%" }}
      >
        <LoadingImage
          key={imageId}
          src={src}
          placeholderSrc={placeholderSrc}
          fallbackSrc={fallbackSrc}
          onFailed={onFailed}
          alt={fileName}
          className="flex size-full items-center justify-center overflow-visible"
          imgClassName="max-h-full max-w-full object-contain select-none will-change-transform [-webkit-user-drag:none]"
          skeletonClassName="m-auto size-[min(24rem,100%)]"
        />
      </TransformComponent>
    </TransformWrapper>
  );
}

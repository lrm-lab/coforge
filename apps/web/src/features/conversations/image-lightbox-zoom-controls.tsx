import type { MouseEvent } from "react";
import { Minus, Plus } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import {
  MAX_ZOOM_SCALE,
  MIN_ZOOM_SCALE,
  ZOOM_STEP,
  formatZoomPercent,
} from "./use-lightbox-dismiss-swipe";

const SCALE_EPSILON = 0.005;

export function keepFocusInside(element: HTMLElement) {
  element.closest<HTMLElement>('[role="dialog"]')?.focus();
}

export function LightboxZoomHeaderControls({
  scale,
  onZoomIn,
  onZoomOut,
  onReset,
}: {
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}) {
  const atMin = scale <= MIN_ZOOM_SCALE + SCALE_EPSILON;
  const atMax = scale >= MAX_ZOOM_SCALE - SCALE_EPSILON;

  return (
    <div className="hidden items-center gap-0.5 sm:flex">
      <ButtonUtility
        icon={Minus}
        size="xs"
        color="tertiary"
        tooltip={m.image_lightbox_zoom_out()}
        tooltipShortcut="-"
        isDisabled={atMin}
        onClick={(event: MouseEvent<HTMLElement>) => {
          if (scale - ZOOM_STEP <= MIN_ZOOM_SCALE + SCALE_EPSILON) {
            keepFocusInside(event.currentTarget);
          }
          onZoomOut();
        }}
      />
      <Button
        size="xs"
        color="tertiary"
        noTextPadding
        aria-label={m.image_lightbox_zoom_reset()}
        isDisabled={atMin}
        className="h-7 min-w-11 px-1.5 text-xs font-medium text-tertiary tabular-nums"
        onPress={(event) => {
          keepFocusInside(event.target as HTMLElement);
          onReset();
        }}
      >
        {formatZoomPercent(scale)}
      </Button>
      <ButtonUtility
        icon={Plus}
        size="xs"
        color="tertiary"
        tooltip={m.image_lightbox_zoom_in()}
        tooltipShortcut="+"
        isDisabled={atMax}
        onClick={(event: MouseEvent<HTMLElement>) => {
          if (scale + ZOOM_STEP >= MAX_ZOOM_SCALE - SCALE_EPSILON) {
            keepFocusInside(event.currentTarget);
          }
          onZoomIn();
        }}
      />
      <span aria-hidden="true" className="mx-1 h-4 w-px bg-border-secondary" />
    </div>
  );
}

export function LightboxZoomFooterBar({
  scale,
  paged,
  chromeHidden,
  onZoomIn,
  onZoomOut,
  onReset,
}: {
  scale: number;
  paged: boolean;
  chromeHidden: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}) {
  const atMin = scale <= MIN_ZOOM_SCALE + SCALE_EPSILON;
  const atMax = scale >= MAX_ZOOM_SCALE - SCALE_EPSILON;
  const buttonBase =
    "rounded-full before:rounded-full touch-manipulation select-none text-fg-secondary disabled:opacity-40";

  return (
    <div
      data-lightbox-zoom-bar=""
      className={cn(
        "flex shrink-0 justify-center px-4 pt-1 transition-opacity duration-150 sm:hidden",
        paged ? "pb-1" : "pb-4",
        chromeHidden && "pointer-events-none opacity-0",
      )}
    >
      <div className="inline-flex items-center gap-1 rounded-full bg-primary/90 px-1.5 py-0.5 shadow-sm ring-1 ring-secondary ring-inset backdrop-blur-md motion-reduce:backdrop-blur-none">
        <Button
          size="xs"
          color="tertiary"
          noTextPadding
          aria-label={m.image_lightbox_zoom_out()}
          isDisabled={atMin}
          className={cn(
            buttonBase,
            "size-11 p-0 [&>span]:flex [&>span]:items-center [&>span]:justify-center",
          )}
          onPress={(event) => {
            if (scale - ZOOM_STEP <= MIN_ZOOM_SCALE + SCALE_EPSILON) {
              keepFocusInside(event.target as HTMLElement);
            }
            onZoomOut();
          }}
        >
          <Minus aria-hidden="true" className="size-4" />
        </Button>
        <Button
          size="xs"
          color="tertiary"
          noTextPadding
          aria-label={m.image_lightbox_zoom_reset()}
          isDisabled={atMin}
          className={cn(buttonBase, "h-11 min-w-14 px-2 text-xs font-medium tabular-nums")}
          onPress={(event) => {
            keepFocusInside(event.target as HTMLElement);
            onReset();
          }}
        >
          {formatZoomPercent(scale)}
        </Button>
        <Button
          size="xs"
          color="tertiary"
          noTextPadding
          aria-label={m.image_lightbox_zoom_in()}
          isDisabled={atMax}
          className={cn(
            buttonBase,
            "size-11 p-0 [&>span]:flex [&>span]:items-center [&>span]:justify-center",
          )}
          onPress={(event) => {
            if (scale + ZOOM_STEP >= MAX_ZOOM_SCALE - SCALE_EPSILON) {
              keepFocusInside(event.target as HTMLElement);
            }
            onZoomIn();
          }}
        >
          <Plus aria-hidden="true" className="size-4" />
        </Button>
      </div>
    </div>
  );
}

import type { MouseEvent } from "react";
import { Toolbar } from "react-aria-components";
import { Minus, Plus } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { keepFocusInside } from "./image-lightbox-zoom-controls";
import {
  SHARE_ZOOM_DEFAULT_SCALE,
  SHARE_ZOOM_EPSILON,
  SHARE_ZOOM_MAX_SCALE,
  shareZoomStepTarget,
} from "./message-share-image-model";
import { formatZoomPercent } from "./use-lightbox-dismiss-swipe";

type ShareZoomControlsProps = {
  scale: number;
  overviewScale: number;
  canOverview: boolean;
  isOverview: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  onToggleOverview: () => void;
};

function useZoomControlBounds(
  scale: number,
  overviewScale: number,
  canOverview: boolean,
  isOverview: boolean,
) {
  const minScale = canOverview ? overviewScale : SHARE_ZOOM_DEFAULT_SCALE;
  const atMin = scale <= minScale + SHARE_ZOOM_EPSILON;
  const atDefault = !isOverview && Math.abs(scale - SHARE_ZOOM_DEFAULT_SCALE) <= SHARE_ZOOM_EPSILON;
  const atMax = scale >= SHARE_ZOOM_MAX_SCALE - SHARE_ZOOM_EPSILON;
  const nextOutHitsMin =
    shareZoomStepTarget(scale, "out", overviewScale).scale <= minScale + SHARE_ZOOM_EPSILON;
  const nextInHitsMax =
    shareZoomStepTarget(scale, "in", overviewScale).scale >=
    SHARE_ZOOM_MAX_SCALE - SHARE_ZOOM_EPSILON;
  return { atMin, atDefault, atMax, nextOutHitsMin, nextInHitsMax };
}

export function ShareZoomHeaderControls({
  scale,
  overviewScale,
  canOverview,
  isOverview,
  onZoomIn,
  onZoomOut,
  onReset,
  onToggleOverview,
}: ShareZoomControlsProps) {
  const { atMin, atDefault, atMax, nextOutHitsMin, nextInHitsMax } = useZoomControlBounds(
    scale,
    overviewScale,
    canOverview,
    isOverview,
  );

  return (
    <Toolbar
      aria-label={m.message_share_zoom_controls()}
      className="hidden items-center gap-0.5 sm:flex"
    >
      <Button
        size="xs"
        color="tertiary"
        noTextPadding
        aria-pressed={isOverview}
        isDisabled={!canOverview}
        className={cn(
          "mr-0.5 h-7 px-2 text-xs font-medium",
          isOverview
            ? "bg-tertiary text-primary ring-1 ring-primary ring-inset"
            : "text-secondary ring-1 ring-secondary ring-inset hover:bg-primary_hover hover:text-primary",
        )}
        onPress={onToggleOverview}
      >
        {m.message_share_zoom_overview()}
      </Button>
      <ButtonUtility
        icon={Minus}
        size="xs"
        color="tertiary"
        tooltip={m.image_lightbox_zoom_out()}
        tooltipShortcut="-"
        isDisabled={atMin}
        onClick={(event: MouseEvent<HTMLElement>) => {
          if (nextOutHitsMin) keepFocusInside(event.currentTarget);
          onZoomOut();
        }}
      />
      <Button
        size="xs"
        color="tertiary"
        noTextPadding
        aria-label={m.image_lightbox_zoom_reset()}
        isDisabled={atDefault}
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
          if (nextInHitsMax) keepFocusInside(event.currentTarget);
          onZoomIn();
        }}
      />
      <span aria-hidden="true" className="mx-1 h-4 w-px bg-border-secondary" />
    </Toolbar>
  );
}

export function ShareZoomMobileBar({
  scale,
  overviewScale,
  canOverview,
  isOverview,
  onZoomIn,
  onZoomOut,
  onReset,
  onToggleOverview,
}: ShareZoomControlsProps) {
  const { atMin, atDefault, atMax, nextOutHitsMin, nextInHitsMax } = useZoomControlBounds(
    scale,
    overviewScale,
    canOverview,
    isOverview,
  );
  const buttonBase =
    "rounded-full before:rounded-full touch-manipulation select-none text-fg-secondary disabled:opacity-40";

  return (
    <Toolbar
      aria-label={m.message_share_zoom_controls()}
      data-share-zoom-bar=""
      className="flex shrink-0 justify-center border-b border-secondary bg-secondary px-3 py-1.5 sm:hidden"
    >
      <div className="inline-flex items-center gap-0.5 rounded-full bg-primary/90 px-1.5 py-0.5 shadow-xs ring-1 ring-secondary ring-inset backdrop-blur-md motion-reduce:backdrop-blur-none">
        <Button
          size="xs"
          color="tertiary"
          noTextPadding
          aria-pressed={isOverview}
          isDisabled={!canOverview}
          className={cn(
            buttonBase,
            "h-11 px-3 text-xs font-medium",
            isOverview && "bg-tertiary text-primary ring-1 ring-primary ring-inset",
          )}
          onPress={onToggleOverview}
        >
          {m.message_share_zoom_overview()}
        </Button>
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
            if (nextOutHitsMin) keepFocusInside(event.target as HTMLElement);
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
          isDisabled={atDefault}
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
            if (nextInHitsMax) keepFocusInside(event.target as HTMLElement);
            onZoomIn();
          }}
        >
          <Plus aria-hidden="true" className="size-4" />
        </Button>
      </div>
    </Toolbar>
  );
}

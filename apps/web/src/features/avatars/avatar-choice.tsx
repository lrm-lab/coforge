import type { ReactNode } from "react";
import { Radio } from "react-aria-components";

import { cx } from "#src/utils/cx";

import { AvatarSticker, StickerInitial, StickerPicture } from "./avatar-sticker";
import { isStickerPicture } from "./sticker-picture";

/**
 * One picture in an avatar picker's radio grid (a person's presets, an Agent's mascots): an Agent's
 * mascot as a sticker, a person's portrait as a round picture, with its label beneath unless
 * `hideLabel` leaves it to screen readers. The selection is a brand ring that hugs the circle, a
 * pointer over it a faint one. `src` is the still picture; a picker whose figures move passes
 * `figure`, given whether the pointer is over the tile, to draw that in its place.
 */
export function AvatarChoice({
  value,
  src,
  label,
  figure,
  hideLabel = false,
}: {
  value: string;
  src: string;
  label: string;
  figure?: (hovered: boolean) => ReactNode;
  hideLabel?: boolean;
}) {
  return (
    <Radio
      value={value}
      aria-label={hideLabel ? label : undefined}
      className="group flex cursor-pointer flex-col items-center gap-2 outline-hidden"
    >
      {({ isSelected, isFocusVisible, isHovered }) => (
        <>
          <span
            className={cx(
              "block aspect-square w-full rounded-full ring-offset-2 ring-offset-primary transition-shadow",
              isSelected ? "ring-2 ring-brand" : "group-hover:ring-2 group-hover:ring-secondary",
              isFocusVisible && "outline-2 outline-offset-4 outline-focus-ring",
            )}
          >
            {figure || isStickerPicture(src) ? (
              <AvatarSticker size="fill">
                {figure ? (
                  figure(isHovered)
                ) : (
                  <StickerPicture
                    src={src}
                    fallback={<StickerInitial initial={label.charAt(0)} />}
                  />
                )}
              </AvatarSticker>
            ) : (
              <img src={src} alt="" className="size-full rounded-full object-cover" />
            )}
          </span>
          {hideLabel ? null : <span className="text-xs text-tertiary">{label}</span>}
        </>
      )}
    </Radio>
  );
}

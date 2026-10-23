import type { ReactNode } from "react";
import { Radio } from "react-aria-components";

import { cx } from "#src/utils/cx";

import { AvatarSticker, StickerInitial, StickerPicture } from "./avatar-sticker";

/**
 * One picture in an avatar picker's radio grid (a person's presets, an Agent's mascots): the
 * platform figure as a sticker on a tile that shows the selection and the keyboard focus, and its
 * label beneath. The selection is neutral (a ring and a light fill), not the brand colour. `src` is
 * the still picture; a picker whose figures move passes `figure`, given whether the pointer is over
 * the tile, to draw that in its place.
 */
export function AvatarChoice({
  value,
  src,
  label,
  figure,
}: {
  value: string;
  src: string;
  label: string;
  figure?: (hovered: boolean) => ReactNode;
}) {
  return (
    <Radio
      value={value}
      className="group flex cursor-pointer flex-col items-center gap-2 outline-hidden"
    >
      {({ isSelected, isFocusVisible, isHovered }) => (
        <>
          <span
            className={cx(
              "w-full rounded-2xl p-1 transition-colors",
              isSelected ? "bg-secondary ring-2 ring-primary" : "group-hover:bg-secondary",
              isFocusVisible && "outline-2 outline-offset-2 outline-focus-ring",
            )}
          >
            <span className="block aspect-square w-full">
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
            </span>
          </span>
          <span className="text-xs text-tertiary">{label}</span>
        </>
      )}
    </Radio>
  );
}

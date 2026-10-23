import { Radio } from "react-aria-components";

import { cx } from "#src/utils/cx";
import { isMascotPicture } from "#src/features/agents/mascot-contract";

/**
 * One picture in an avatar picker's radio grid (a person's presets, an Agent's mascots): the
 * picture on a tile that shows the selection and the keyboard focus, and its label beneath. A
 * mascot is shown whole; a preset photo fills its rounded square.
 */
export function AvatarChoice({
  value,
  src,
  label,
  lazy = false,
}: {
  value: string;
  src: string;
  label: string;
  /** Defer loading the picture until it nears the screen (a long grid). */
  lazy?: boolean;
}) {
  return (
    <Radio
      value={value}
      className="group flex cursor-pointer flex-col items-center gap-2 outline-hidden"
    >
      {({ isSelected, isFocusVisible }) => (
        <>
          <span
            className={cx(
              "rounded-2xl p-1 transition-colors",
              isSelected ? "bg-brand-primary ring-2 ring-focus-ring" : "group-hover:bg-secondary",
              isFocusVisible && "outline-2 outline-offset-2 outline-focus-ring",
            )}
          >
            <img
              src={src}
              alt=""
              loading={lazy ? "lazy" : undefined}
              className={cx(
                "aspect-square w-full",
                isMascotPicture(src) ? "object-contain" : "rounded-xl object-cover",
              )}
            />
          </span>
          <span className="text-xs text-tertiary">{label}</span>
        </>
      )}
    </Radio>
  );
}

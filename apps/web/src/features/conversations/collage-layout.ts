/**
 * Where each member circle of a channel's group avatar sits inside its round frame. `left`, `top`
 * and `size` are fractions of the frame's side, so one layout serves every frame size; `css` is the
 * same placement as ready inline-style values (the frame's side is the `--avatar-group-size`
 * custom property, which scales the initials). Circles overlap and later ones draw over earlier
 * ones. At most four are shown; above four members the first three are shown and the fourth slot
 * is the overflow "…" circle (`overflow: true`). No members has no collage (`[]`): the row shows
 * the channel's icon instead.
 */
export type CollageSlot = {
  left: number;
  top: number;
  size: number;
  overflow: boolean;
  css: { left: string; top: string; width: string; height: string; fontSize: string };
};

const MAX_SLOTS = 4;

/** A slot placed on a 48-unit frame. */
function slot(left: number, top: number, size: number, overflow = false): CollageSlot {
  const fraction = size / 48;
  const percent = `${fraction * 100}%`;
  return {
    left: left / 48,
    top: top / 48,
    size: fraction,
    overflow,
    css: {
      left: `${(left / 48) * 100}%`,
      top: `${(top / 48) * 100}%`,
      width: percent,
      height: percent,
      // Initials scale with the frame, not with the root font size, down to a readable floor.
      fontSize: `max(0.625rem, calc(var(--avatar-group-size) * ${fraction * 0.4}))`,
    },
  };
}

const FOUR: readonly CollageSlot[] = [
  // Overlapping 2 by 2.
  slot(5, 5, 24),
  slot(19, 5, 24),
  slot(5, 19, 24),
  slot(19, 19, 24),
];

const LAYOUTS: readonly (readonly CollageSlot[])[] = [
  [],
  [slot(0, 0, 48)],
  // Diagonal pair: top-left under bottom-right.
  [slot(3, 3, 28), slot(17, 17, 28)],
  // Two on top, one centred below.
  [slot(5, 4, 26), slot(17, 4, 26), slot(11, 18, 26)],
  FOUR,
];

/** Above four members: the first three, then the overflow circle standing for the rest. */
const OVERFLOW: readonly CollageSlot[] = FOUR.map((placed, index) =>
  index === MAX_SLOTS - 1 ? { ...placed, overflow: true } : placed,
);

/**
 * The slots for `count` members, in member order. Above four members the last slot is the
 * overflow circle and stands for the rest.
 */
export function collageLayout(count: number): readonly CollageSlot[] {
  const members = Math.max(0, Math.floor(count));
  if (members > MAX_SLOTS) return OVERFLOW;
  return LAYOUTS[members] ?? [];
}

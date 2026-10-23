/**
 * Where each member of a channel's group avatar sits on its round frame. `left`, `top` and `size`
 * are fractions of the frame's side, so one layout serves every frame size; `css` is the same
 * placement as ready inline-style values (the frame's side is the `--avatar-group-size` custom
 * property, which scales the initials). Members are stickers: each slot is about half the frame
 * or more, they overlap one another, the cluster sits on the frame's centre and may pass its edge
 * a little, and a later slot draws over an earlier one. At most four are shown; above four
 * members the first three are shown and the fourth slot is the overflow "…" sticker
 * (`overflow: true`). No members has no collage (`[]`): the row shows the channel's icon instead.
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
  // A tight 2 by 2, each a little off the grid so it reads as a handful of stickers: top-left
  // behind, top-right over it, then the bottom row, bottom-right over everything it touches.
  slot(3, 3, 26),
  slot(19, 2, 26),
  slot(2, 19, 26),
  slot(19, 20, 26),
];

const LAYOUTS: readonly (readonly CollageSlot[])[] = [
  [],
  [slot(0, 0, 48)],
  // Diagonal pair: the second lower right, over the first.
  [slot(1, 1, 29), slot(18, 18, 29)],
  // One at the top centre behind, two overlapping below it, the right one a little higher.
  [slot(10, 1, 28), slot(0, 20, 28), slot(20, 18, 28)],
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

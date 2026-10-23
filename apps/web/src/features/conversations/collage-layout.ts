/**
 * Where each member of a channel's group avatar sits inside its round frame. `left`, `top` and
 * `size` are fractions of the frame's side, so one layout serves every frame size; `css` is the
 * same placement as ready inline-style values (the frame's side is the `--avatar-group-size`
 * custom property, which scales the initials). Slots overlap by at most two units of 48 so each
 * face reads whole (an Agent's mascot is drawn unclipped, a person's photo in a circle); later
 * ones draw over earlier ones. At most four are shown; above four members the first three are shown and the fourth slot
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
  // 2 by 2, one unit of overlap; the corners lie just outside the round frame's edge.
  slot(1.5, 1.5, 23),
  slot(23.5, 1.5, 23),
  slot(1.5, 23.5, 23),
  slot(23.5, 23.5, 23),
];

const LAYOUTS: readonly (readonly CollageSlot[])[] = [
  [],
  [slot(0, 0, 48)],
  // Diagonal pair: top-left under bottom-right, meeting at their corners.
  [slot(1, 1, 24), slot(23, 23, 24)],
  // Two on top, one centred below.
  [slot(2, 3, 22), slot(24, 3, 22), slot(13, 24, 22)],
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

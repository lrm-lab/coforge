export type CollageSlot = {
  left: number;
  top: number;
  size: number;
  overflow: boolean;
  css: { left: string; top: string; width: string; height: string; fontSize: string };
};

const MAX_SLOTS = 4;

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
      fontSize: `max(0.625rem, calc(var(--avatar-group-size) * ${fraction * 0.4}))`,
    },
  };
}

const FACE = 24;

const FOUR: readonly CollageSlot[] = [
  slot(3, 3, FACE),
  slot(21, 3, FACE),
  slot(3, 21, FACE),
  slot(21, 21, FACE),
];

const LAYOUTS: readonly (readonly CollageSlot[])[] = [
  [],
  [slot(0, 0, 48)],
  [slot(2, 12, FACE), slot(22, 12, FACE)],
  [slot(12, 3, FACE), slot(3, 21, FACE), slot(21, 21, FACE)],
  FOUR,
];

const OVERFLOW: readonly CollageSlot[] = FOUR.map((placed, index) =>
  index === MAX_SLOTS - 1 ? { ...placed, overflow: true } : placed,
);

export function collageLayout(count: number): readonly CollageSlot[] {
  const members = Math.max(0, Math.floor(count));
  if (members > MAX_SLOTS) return OVERFLOW;
  return LAYOUTS[members] ?? [];
}

export type Slot = { start: number; size: number };

const FALLOFF = 0.7;
const STEP_DELAY_MS = 24;

export function ripple(index: number, gap: number, amplitude: number) {
  const before = index < gap;
  const distance = before ? gap - 1 - index : index - gap;
  const offset = amplitude * FALLOFF ** distance;
  return { offset: before ? -offset : offset, delayMs: STEP_DELAY_MS * distance };
}

export function sourceExtent(slots: readonly Slot[], source: number) {
  const slot = slots[source];
  if (!slot) return 0;
  const next = slots[source + 1];
  if (next) return next.start - slot.start;
  const previous = slots[source - 1];
  return previous ? slot.start + slot.size - (previous.start + previous.size) : slot.size;
}

export function closedSlots(slots: readonly Slot[], source: number | null): Slot[] {
  if (source === null) return [...slots];
  const extent = sourceExtent(slots, source);
  return slots
    .filter((_, index) => index !== source)
    .map((slot, index) => (index < source ? slot : { ...slot, start: slot.start - extent }));
}

export function gapAt(closed: readonly Slot[], point: number) {
  return closed.filter((slot) => slot.start + slot.size / 2 < point).length;
}

export function lineAt(closed: readonly Slot[], gap: number) {
  const before = closed[gap - 1];
  const after = closed[gap];
  if (before && after) return (before.start + before.size + after.start) / 2;
  if (after) return after.start;
  if (before) return before.start + before.size;
  return 0;
}

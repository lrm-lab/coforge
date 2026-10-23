/**
 * Where a mascot looks: the pure map from the pointer's offset to the Rive file's `lookX` /
 * `lookY` (`MASCOT_RIVE`), each in [-1, 1]. 0 is straight ahead, +x right, +y down (screen
 * orientation, like the offset). How far the eyes move for a full deflection is the file's, not
 * the app's.
 */
export interface MascotLook {
  x: number;
  y: number;
}

export const STRAIGHT_AHEAD: MascotLook = { x: 0, y: 0 };

/** The pointer distance, in CSS pixels, at which the eyes are fully turned. */
export const LOOK_FULL_DISTANCE_PX = 300;

/**
 * The look for a pointer `dx` / `dy` pixels from the mascot's centre. It points the way the
 * pointer lies, and its length grows with the distance on a curve that flattens toward
 * `LOOK_FULL_DISTANCE_PX` (a pointer over the mascot barely moves the eyes, one beyond the full
 * distance turns them fully and no further). A non-finite offset looks straight ahead.
 */
export function lookToward(dx: number, dy: number): MascotLook {
  const distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance) || distance === 0) return STRAIGHT_AHEAD;
  const progress = Math.min(distance / LOOK_FULL_DISTANCE_PX, 1);
  const deflection = 1 - (1 - progress) ** 2;
  return { x: (dx / distance) * deflection, y: (dy / distance) * deflection };
}

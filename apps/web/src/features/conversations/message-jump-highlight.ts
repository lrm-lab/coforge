/** How long a landed position jump keeps its highlight. The hash deep link leans on `:target`,
 * which lasts until the hash moves; the saved jump has no hash to lean on, so it needs a bound.
 * 2.5s hold + the row's 500ms transition out = the ~3s window the ruling settled on (2026-09-23:
 * "2.5–3s 合适的窗口，符合我们的 design" — bg-tertiary wash + brand ring, fading to normal). */
export const JUMP_HIGHLIGHT_MS = 2500;

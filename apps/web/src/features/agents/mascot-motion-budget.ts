/**
 * How many mascots may move at once (Frank, task #433): each one draws every frame on the main
 * thread, and a page can show half a dozen. The rest show the frame they stopped on.
 */
export const MASCOT_MOTION_LIMIT = 3;

/** One mounted mascot as the page shows it now, in the order of the page. */
type SeenMascot = {
  id: string;
  /** Any part of it inside the viewport. Off screen, the runtime already stops drawing it. */
  onScreen: boolean;
  /** Something else is drawn over its centre: another face of a stack, a dialog. */
  covered: boolean;
  hovered: boolean;
  /** Its Agent's activity, or the pointer over it, changed a moment ago: held now, it would keep
   * the pose it was in. */
  settling: boolean;
  /** Its Agent is working or thinking: moving shows what it is doing. */
  atWork: boolean;
  /** The mascot picker's choices, which all move by design (`agent-avatar-dialog.tsx`). */
  uncapped: boolean;
};

/**
 * Which on-screen mascots move and which hold still. A covered one never moves and takes no
 * place. Then, up to the limit: the one under the pointer; then any whose activity or hover just changed;
 * Agents working or thinking before the rest (idle, offline, in error); and the last on the page first, which puts what was opened over
 * the page (a hover card, a popover, both portaled to its end) and the open conversation before the
 * sidebar, rendered ahead of them. Pure: `mascot-rive.tsx` measures the page and plays or pauses.
 */
export function mascotsInMotion(mascots: readonly SeenMascot[]): {
  play: Set<string>;
  pause: Set<string>;
} {
  const play = new Set<string>();
  const pause = new Set<string>();
  const candidates: { mascot: SeenMascot; place: number }[] = [];
  mascots.forEach((mascot, place) => {
    if (!mascot.onScreen) return;
    if (mascot.covered) pause.add(mascot.id);
    else if (mascot.uncapped) play.add(mascot.id);
    else candidates.push({ mascot, place });
  });
  const rank = ({ mascot }: { mascot: SeenMascot }) =>
    (mascot.hovered ? 0 : mascot.settling ? 2 : 4) + (mascot.atWork ? 0 : 1);
  candidates
    .sort((a, b) => rank(a) - rank(b) || b.place - a.place)
    .forEach(({ mascot }, index) => (index < MASCOT_MOTION_LIMIT ? play : pause).add(mascot.id));
  return { play, pause };
}

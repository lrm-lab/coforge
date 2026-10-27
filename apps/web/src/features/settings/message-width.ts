import { bootFragment } from "./boot-fragment";

const STORAGE_KEY = "coforge-message-width";
/** How "full width" is stored. Anything else reads as the default column. */
const FULL_WIDTH = "full";
const FULL_WIDTH_CLASS = "message-full-width";

/** The main message stream's side room: at most 6.5rem on each side, which with the
 *  rows' own gutter puts the avatars where the design mockup has them, and 10% of the pane when
 *  the pane is narrower than the mockup, so the room never grows with a wide screen. A narrow
 *  pane (beside an open thread, say) gives the room up, as Raft keeps only its gutter: below
 *  about 44rem (698px) it is 37.5% of the pane less 12rem instead, none up to 32rem; an ordinary
 *  desktop window's pane (760px at 1280px) is wider and keeps the 10%. The history,
 *  the notification banner and the composer below it share this one class list so they always
 *  line up; full-width messages drop the room. Below `md` the rows' own gutter is enough. */
export const MESSAGE_COLUMN_CLASS =
  "md:px-[clamp(0px,37.5%_-_12rem,min(6.5rem,10%))] [.message-full-width_&]:px-0";

/** The boot half of the same rule: `__root.tsx` runs this before paint so SSR markup never depends
 * on the class. Built by `bootFragment` from the key, the stored value and the class above, so the
 * script and `readMessageFullWidth` cannot disagree about what "full" is stored as.
 *
 * This setting uses the fragment but not `device-flag.ts`: that module's readers ask whether a flag
 * is hidden, and "full" is not the hiding of anything. */
export const MESSAGE_WIDTH_BOOT = bootFragment({
  key: STORAGE_KEY,
  token: FULL_WIDTH,
  className: FULL_WIDTH_CLASS,
});

/** Per-device preference: full-width messages. Applied as a class on <html> (also by the boot
 *  script in __root.tsx) so SSR markup never depends on it. */
export function readMessageFullWidth(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === FULL_WIDTH;
  } catch {
    return false;
  }
}

export function writeMessageFullWidth(full: boolean) {
  try {
    if (full) localStorage.setItem(STORAGE_KEY, FULL_WIDTH);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode or blocked storage: the class still applies for this page.
  }
  document.documentElement.classList.toggle(FULL_WIDTH_CLASS, full);
}

/** The composer's box: its margins, border, corners, background and padding. The conversation's
 * loading screen draws the same box around one row of the composer's 32px buttons, so the two
 * stay the same size and the stream does not jump when the conversation loads. */
export const COMPOSER_FRAME_CLASS =
  "relative mx-4 mt-2 mb-3 flex shrink-0 flex-col gap-1 rounded-lg border border-field-border bg-primary p-2 shadow-xs md:mx-6";

/** The same box without the stream's margins, for a composer set inside something else (the
 * forward dialog's note, task #50), so it looks like the one under the messages. */
export const COMPOSER_BOX_CLASS =
  "relative flex shrink-0 flex-col gap-1 rounded-lg border border-field-border bg-primary p-2 shadow-xs";

/** How the live composer's box shows it has focus: the spec's typing state, a 2px violet border
 * (task #104) drawn as the 1px border plus a 1px inset ring, so the text does not move; the loading
 * screen's copy never takes focus. Forced colors drop the ring with every shadow, so there an
 * outline marks the focus instead. */
export const COMPOSER_FOCUS_CLASS =
  "transition-[border-color,box-shadow] focus-within:border-field-border-typing focus-within:shadow-[0_1px_2px_rgb(0_0_0/0.05),inset_0_0_0_1px_var(--color-field-border-typing)] forced-colors:focus-within:outline-2";

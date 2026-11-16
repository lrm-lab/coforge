/**
 * A text field's look in each of its states, from the design spec (task #104, jing 11-13; typing
 * revised 11-16; every field, task #112). One place for all of them: the shared Input, TextArea,
 * Select, ComboBox and code slots, and the few boxes drawn by hand around a stripped field. Each
 * part is a whole class list for `cx`; a field adds the ones its state calls for.
 *
 * The box is a 1px inset ring, so the typing state's 2px ring grows inward and the text never
 * moves. Rings are shadows, which forced colors drop: a field being typed in keeps an outline
 * there.
 */
export const FIELD_STATES = {
  /** At rest, and filled: the resting border, the 1px drop shadow, 8px corners. */
  box: "rounded-lg bg-primary shadow-xs ring-1 ring-field-border ring-inset transition-shadow duration-100 ease-linear",
  /** What is typed, and the placeholder. */
  text: "text-field-text placeholder:text-field-placeholder",
  /** Being typed in (focused, or a select open). */
  typing: "ring-2 ring-field-border-typing forced-colors:outline-2",
  /** Not available: the disabled fill, with lighter text and the not-allowed pointer, so the
   * fill is not the only sign (Raft, task #112). */
  disabled: "cursor-not-allowed bg-field-bg-disabled text-tertiary",
  /** Holding a value that is wrong. */
  invalid: "ring-field-border-error",
  /** Holding a value that is wrong, and being typed in. */
  invalidTyping: "ring-2 ring-field-border-error forced-colors:outline-2",
  /** A box drawn around a field whose own box is stripped (a composer), or around a plain
   * `<input>`: a real 1px border, the shadow and corners. */
  frame: "rounded-lg border border-field-border bg-primary shadow-xs",
  /** A `frame` while anything in it is typed in: the 1px border plus a 1px inset ring, so the
   * text does not move. Forced colors drop the ring with every shadow, so an outline marks the
   * focus there instead. */
  frameTyping:
    "transition-[border-color,box-shadow] focus-within:border-field-border-typing focus-within:shadow-[0_1px_2px_rgb(0_0_0/0.05),inset_0_0_0_1px_var(--color-field-border-typing)] forced-colors:focus-within:outline-2",
} as const;

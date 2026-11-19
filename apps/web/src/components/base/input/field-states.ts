export const FIELD_STATES = {
  box: "rounded-lg bg-primary shadow-xs ring-1 ring-field-border ring-inset transition-shadow duration-100 ease-out",
  text: "text-field-text placeholder:text-field-placeholder",
  typing: "ring-2 ring-field-border-typing forced-colors:outline-2",
  focusTyping:
    "[&:focus]:ring-2 [&:focus]:ring-field-border-typing forced-colors:[&:focus]:outline-2",
  focusWithinTyping:
    "[&:focus-within]:ring-2 [&:focus-within]:ring-field-border-typing forced-colors:[&:focus-within]:outline-2",
  disabled: "cursor-not-allowed bg-field-bg-disabled text-tertiary",
  invalid: "ring-field-border-error",
  invalidTyping: "ring-2 ring-field-border-error forced-colors:outline-2",
  focusInvalidTyping:
    "[&:focus]:ring-2 [&:focus]:ring-field-border-error forced-colors:[&:focus]:outline-2",
  focusWithinInvalidTyping:
    "[&:focus-within]:ring-2 [&:focus-within]:ring-field-border-error forced-colors:[&:focus-within]:outline-2",
  frame: "rounded-lg border border-field-border bg-primary shadow-xs",
  frameTyping:
    "transition-[border-color,box-shadow] focus-within:border-field-border-typing focus-within:shadow-[0_1px_2px_rgb(0_0_0/0.05),inset_0_0_0_1px_var(--color-field-border-typing)] forced-colors:focus-within:outline-2",
} as const;

/** What one command's `--help` prints: the form to type, its flags and one worked example. */
export type HelpEntry = {
  syntax: string;
  flags?: readonly string[];
  /** Prose after the flags: rules that do not fit on a flag's line. */
  guidance?: string;
  example?: string;
};

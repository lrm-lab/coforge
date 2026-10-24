/** Roughly four characters (or bytes) to a token, as the reference client estimates. */
export const CHARS_PER_TOKEN = 4;

/** The tokens `size` characters (or bytes) come to, at least one. */
export function estimateTokens(size: number): number {
  return Math.max(1, Math.floor((size + CHARS_PER_TOKEN - 1) / CHARS_PER_TOKEN));
}

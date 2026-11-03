/** Who sealed a reminder: one line, at most 120 characters. */
export const SEAL_OWNER_MAX_CHARS = 120;
/** The condition it is released under: one line, at most 500 characters (one or two sentences). */
export const SEAL_UNTIL_MAX_CHARS = 500;

export function sealText(
  value: string | undefined,
  field: string,
  maxChars: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim() || value.length > maxChars || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error(`invalid reminder seal ${field}`);
  return value;
}

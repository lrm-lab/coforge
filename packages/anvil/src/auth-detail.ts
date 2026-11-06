/**
 * A bounded, single-line diagnostic from an auth child's failure: unknown values stringify,
 * control characters become spaces, and the result caps at 512 chars.
 */
export function authDetail(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return undefined;
  return text.replace(/\p{Cc}/gu, " ").slice(0, 512);
}

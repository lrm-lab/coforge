import { createHash } from "node:crypto";

/**
 * `value` as JSON, sorted by key at every level, so equal values hash alike. A key whose value is
 * `undefined` is left out, as `JSON.stringify` leaves it, so an absent field and an unset one are
 * the same.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** The SHA-256 (hex) of a value in its canonical form: a request's hash, for idempotent retries. */
export const payloadHash = (payload: unknown) =>
  createHash("sha256").update(canonicalJson(payload)).digest("hex");

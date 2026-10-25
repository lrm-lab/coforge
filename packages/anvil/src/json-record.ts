import { isRecord } from "@lrm/coforge-sdk/internal";

/** A loosely typed JSON record a provider process emits; the helpers below narrow its fields. */
export type JsonRecord = Readonly<Record<string, unknown>>;

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** `value` when it is an integer; a provider's `null` or any other value is `undefined`. */
export function integerField(value: unknown): number | undefined {
  return Number.isInteger(value) ? (value as number) : undefined;
}

/** Joins the `text` blocks of a provider content array; a bare string is returned as is. */
export function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map(asRecord)
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block!.text as string)
    .join("");
}

export function eventTime(record: Readonly<Record<string, unknown>>): string {
  return typeof record.timestamp === "string" && !Number.isNaN(Date.parse(record.timestamp))
    ? record.timestamp
    : new Date().toISOString();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

/** `value` when it is a non-empty string, otherwise `undefined`. */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

import { asRecord } from "#src/json-record";

export type KiroWhoamiResult = Readonly<{
  data?: Record<string, unknown>;
  state: "logged_in" | "logged_out" | "unknown";
}>;

/** Parses Kiro's JSON identity before its optional human-readable Profile section. */
export function parseKiroWhoami(text: string): KiroWhoamiResult {
  const value = identity(text);
  if (!value) return { state: "unknown" };
  if ("account" in value)
    return { data: value, state: value.account === null ? "logged_out" : "logged_in" };
  return {
    data: value,
    state: typeof value.accountType === "string" ? "logged_in" : "unknown",
  };
}

function identity(text: string): Record<string, unknown> | undefined {
  const s = text.trimStart();
  if (!s.startsWith("{")) return undefined;
  for (let end = s.indexOf("}"); end >= 0; end = s.indexOf("}", end + 1)) {
    try {
      return asRecord(JSON.parse(s.slice(0, end + 1)));
    } catch {
      // A nested object may close before the outer JSON object.
    }
  }
  return undefined;
}

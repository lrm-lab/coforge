import { RFC_UUID_PATTERN } from "./uuid";

const MAX_ITEMS = 20;
const MAX_STATEMENT_CHARS = 500;
const MAX_TITLE_CHARS = 200;

/** Agent HTTPS body for weekly-report memory settlement write-back. */
export type WeeklyReportMemoryCommand = {
  idempotencyKey: string;
  reportId: string;
  year: number;
  week: number;
  preferences: string[];
  explicitRules: Array<{ statement: string; effect: "adopt" | "retire" }>;
  factCorrections: string[];
  threads: Array<{ title: string; status: "open" | "done" }>;
};

export type WeeklyReportMemoryResult = {
  idempotencyKey: string;
  reportId: string;
  status: string;
};

function trimmedItems(value: unknown, maxChars: number): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const text = item.trim().replace(/\s+/g, " ");
    if (text.length === 0 || text.length > maxChars) return null;
    items.push(text);
  }
  return items;
}

/** Validates the Agent HTTPS / proxy memory body before it is stored. */
export function validateWeeklyReportMemoryCommand(
  payload: Record<string, unknown>,
): WeeklyReportMemoryCommand | null {
  if (typeof payload.idempotencyKey !== "string" || !RFC_UUID_PATTERN.test(payload.idempotencyKey))
    return null;
  if (typeof payload.reportId !== "string" || !RFC_UUID_PATTERN.test(payload.reportId)) return null;
  if (
    typeof payload.year !== "number" ||
    !Number.isInteger(payload.year) ||
    payload.year < 2000 ||
    payload.year > 2100
  )
    return null;
  if (
    typeof payload.week !== "number" ||
    !Number.isInteger(payload.week) ||
    payload.week < 1 ||
    payload.week > 53
  )
    return null;
  const preferences = trimmedItems(payload.preferences, MAX_STATEMENT_CHARS);
  const factCorrections = trimmedItems(payload.factCorrections, MAX_STATEMENT_CHARS);
  if (!preferences || !factCorrections) return null;
  if (!Array.isArray(payload.explicitRules) || payload.explicitRules.length > MAX_ITEMS)
    return null;
  const explicitRules: WeeklyReportMemoryCommand["explicitRules"] = [];
  for (const rule of payload.explicitRules) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) return null;
    const record = rule as Record<string, unknown>;
    const statement = trimmedItems([record.statement], MAX_STATEMENT_CHARS);
    if (!statement || (record.effect !== "adopt" && record.effect !== "retire")) return null;
    explicitRules.push({ statement: statement[0]!, effect: record.effect });
  }
  if (!Array.isArray(payload.threads) || payload.threads.length > MAX_ITEMS) return null;
  const threads: WeeklyReportMemoryCommand["threads"] = [];
  for (const thread of payload.threads) {
    if (!thread || typeof thread !== "object" || Array.isArray(thread)) return null;
    const record = thread as Record<string, unknown>;
    const title = trimmedItems([record.title], MAX_TITLE_CHARS);
    if (!title || (record.status !== "open" && record.status !== "done")) return null;
    threads.push({ title: title[0]!, status: record.status });
  }
  return {
    idempotencyKey: payload.idempotencyKey,
    reportId: payload.reportId,
    year: payload.year,
    week: payload.week,
    preferences,
    explicitRules,
    factCorrections,
    threads,
  };
}

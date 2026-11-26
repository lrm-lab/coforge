import { z } from "zod";
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

const normalizedText = (maxChars: number) =>
  z
    .string()
    .transform((value) => value.trim().replace(/\s+/g, " "))
    .pipe(z.string().min(1).max(maxChars));

const uuidSchema = z.string().regex(RFC_UUID_PATTERN);

const weeklyReportMemoryCommandSchema = z.object({
  idempotencyKey: uuidSchema,
  reportId: uuidSchema,
  year: z.int().min(2000).max(2100),
  week: z.int().min(1).max(53),
  preferences: z.array(normalizedText(MAX_STATEMENT_CHARS)).max(MAX_ITEMS),
  explicitRules: z
    .array(
      z.object({
        statement: normalizedText(MAX_STATEMENT_CHARS),
        effect: z.enum(["adopt", "retire"]),
      }),
    )
    .max(MAX_ITEMS),
  factCorrections: z.array(normalizedText(MAX_STATEMENT_CHARS)).max(MAX_ITEMS),
  threads: z
    .array(
      z.object({
        title: normalizedText(MAX_TITLE_CHARS),
        status: z.enum(["open", "done"]),
      }),
    )
    .max(MAX_ITEMS),
});

export function validateWeeklyReportMemoryCommand(
  payload: Record<string, unknown>,
): WeeklyReportMemoryCommand | null {
  const parsed = weeklyReportMemoryCommandSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

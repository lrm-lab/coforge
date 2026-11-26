import { UUID_LIKE_PATTERN } from "@lrm/coforge-sdk/internal";
import { z } from "zod";
import type { ReportContent } from "#src/features/records/records-content";
import type { TemplateOutlineSection } from "#src/features/records/template-outline-sections";

const OPEN = "[weekly-report-suggestion]";
const CLOSE = "[/weekly-report-suggestion]";
const UUID_RE = UUID_LIKE_PATTERN;

function findSuggestionEnvelopeStart(body: string): number {
  let from = 0;
  while (from < body.length) {
    const start = body.indexOf(OPEN, from);
    if (start < 0) return -1;
    const after = body.slice(start + OPEN.length);
    if (/^\s*\{/.test(after)) return start;
    from = start + OPEN.length;
  }
  return -1;
}

export type WeeklyReportBodyEditSuggestion = {
  type: "body-edit";
  reportId: string;
  summary: string;
  content: ReportContent;
  baseUpdatedAt?: string;
};

export type WeeklyReportKeyPointEditSuggestion = {
  type: "key-point-edit";
  reportId: string;
  summary: string;
  markdown: string;
};

export type WeeklyReportSendPromptSuggestion = {
  type: "send-prompt";
  reportId: string;
};

export type WeeklyReportTemplateCreateSuggestion = {
  type: "template-create";
  summary: string;
  name: string;
  sendTime: string;
  sendWeekday: number;
  scheduleEnabled: boolean;
  allMembers: boolean;
  recipientUserIds: string[];
  sections: TemplateOutlineSection[];
};

export type WeeklyReportAssistantSuggestion =
  | { type: "collect-plan"; reportId: string; year: number; week: number }
  | WeeklyReportBodyEditSuggestion
  | WeeklyReportKeyPointEditSuggestion
  | WeeklyReportSendPromptSuggestion
  | WeeklyReportTemplateCreateSuggestion;

export function buildWeeklyReportAssistantSuggestionBody(input: {
  displayText: string;
  suggestion: WeeklyReportAssistantSuggestion;
}): string {
  return [input.displayText.trim(), "", OPEN, JSON.stringify(input.suggestion), CLOSE].join("\n");
}

export function weeklyReportAssistantSuggestionDisplayBody(body: string): string {
  const start = findSuggestionEnvelopeStart(body);
  if (start < 0) return body.trim();
  return body.slice(0, start).trim();
}

export function parseWeeklyReportAssistantSuggestion(
  body: string,
): WeeklyReportAssistantSuggestion | null {
  const start = findSuggestionEnvelopeStart(body);
  if (start < 0) return null;
  const afterOpen = body.slice(start + OPEN.length).trimStart();
  const closeAt = afterOpen.indexOf(CLOSE);
  const candidate =
    closeAt >= 0 ? afterOpen.slice(0, closeAt).trim() : extractLeadingJsonObject(afterOpen);
  if (!candidate) return null;
  try {
    return normalizeSuggestion(JSON.parse(candidate) as unknown);
  } catch {
    return null;
  }
}

function extractLeadingJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return trimmed.slice(0, i + 1);
    }
  }
  return null;
}

const uuidSchema = z.string().regex(UUID_RE);
const nonEmptyTrimmedString = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0);

const templateOutlineSectionSchema = z.object({
  title: z.string(),
  children: z.array(z.string()),
});

const suggestionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("collect-plan"),
    reportId: uuidSchema,
    year: z.int().min(1).max(9999),
    week: z.int().min(1).max(53),
  }),
  z.object({
    type: z.literal("send-prompt"),
    reportId: uuidSchema,
  }),
  z.object({
    type: z.literal("template-create"),
    summary: nonEmptyTrimmedString,
    name: z.string().transform((value) => value.trim()),
    sendTime: z.string(),
    sendWeekday: z.number(),
    scheduleEnabled: z.boolean(),
    allMembers: z.boolean(),
    recipientUserIds: z.array(z.unknown()),
    sections: z.array(templateOutlineSectionSchema).min(1),
  }),
  z.object({
    type: z.literal("key-point-edit"),
    reportId: uuidSchema,
    summary: nonEmptyTrimmedString,
    markdown: z.string().refine((value) => value.trim().length > 0),
  }),
  z.object({
    type: z.literal("body-edit"),
    reportId: uuidSchema,
    summary: nonEmptyTrimmedString,
    baseUpdatedAt: z.union([z.string().min(1), z.null()]).optional(),
    content: z.unknown(),
  }),
]);

function normalizeSuggestion(value: unknown): WeeklyReportAssistantSuggestion | null {
  const parsed = suggestionSchema.safeParse(value);
  if (!parsed.success) return null;
  const data = parsed.data;
  if (data.type === "template-create") {
    return {
      ...data,
      recipientUserIds: data.recipientUserIds.filter((id): id is string => typeof id === "string"),
    };
  }
  if (data.type === "body-edit") {
    const content = parseStoredReportContent(data.content);
    if (!content) return null;
    return {
      type: "body-edit",
      reportId: data.reportId,
      summary: data.summary,
      content,
      ...(typeof data.baseUpdatedAt === "string" ? { baseUpdatedAt: data.baseUpdatedAt } : {}),
    };
  }
  return data;
}

function withParsedTabOrder(
  tabs: NonNullable<ReportContent["tabs"]>,
  rawOrder: unknown,
): ReportContent {
  if (!Array.isArray(rawOrder)) return { tabs };
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const item of rawOrder) {
    if (typeof item !== "string" || seen.has(item) || !Object.hasOwn(tabs, item)) continue;
    seen.add(item);
    ordered.push(item);
  }
  for (const key of Object.keys(tabs)) {
    if (!seen.has(key)) {
      seen.add(key);
      ordered.push(key);
    }
  }
  return {
    tabs: Object.fromEntries(ordered.map((name) => [name, tabs[name]!])),
    ...(ordered.length > 0 ? { tabOrder: ordered } : {}),
  };
}

function parseStoredReportContent(value: unknown): ReportContent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rawOrder = Reflect.get(value, "tabOrder");
  const tabsValue = Reflect.get(value, "tabs");
  if (tabsValue === undefined) {
    const markdown = Reflect.get(value, "markdown");
    if (typeof markdown === "string") return { markdown };
    const flat = asTabMap(value, true);
    return flat?.tabs ? withParsedTabOrder(flat.tabs, rawOrder) : null;
  }
  if (!tabsValue || typeof tabsValue !== "object" || Array.isArray(tabsValue)) return null;
  const parsed = asTabMap(tabsValue, false);
  return parsed?.tabs ? withParsedTabOrder(parsed.tabs, rawOrder) : null;
}

function asTabMap(value: object, ignoreTabOrderKey: boolean): ReportContent | null {
  const tabs: NonNullable<ReportContent["tabs"]> = {};
  for (const [name, tab] of Object.entries(value)) {
    if (ignoreTabOrderKey && name === "tabOrder") continue;
    if (typeof tab === "string") {
      tabs[name] = { markdown: tab };
      continue;
    }
    if (!tab || typeof tab !== "object" || Array.isArray(tab)) return null;
    const markdown = Reflect.get(tab, "markdown");
    if (typeof markdown !== "string") return null;
    tabs[name] = { markdown };
  }
  if (Object.keys(tabs).length === 0) return null;
  return { tabs };
}

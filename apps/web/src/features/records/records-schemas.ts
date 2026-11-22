import { z } from "zod";
import type { ReportContent } from "./records-content";

export const reportContentSchema: z.ZodType<ReportContent> = z.object({
  tabs: z
    .record(z.string().min(1).max(200), z.object({ markdown: z.string().max(200_000) }))
    .refine((tabs) => Object.keys(tabs).length <= 50, { message: "Too many tabs" }),
  tabOrder: z.array(z.string().max(200)).max(50).optional(),
  markdown: z.string().max(200_000).optional(),
  assignment: z.object({ unread: z.boolean() }).optional(),
});

export const saveRecordNoteInputSchema = z.object({
  noteId: z.uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().max(200_000).optional(),
});

export const updateFormatReportMetaInputSchema = z.object({
  reportId: z.uuid(),
  title: z.string().trim().min(1).max(100),
});

export const saveKeyPointPromptsInputSchema = z.object({
  slot: z.enum(["team", "personal"]),
  text: z.string().max(20_000),
});

export const templateSectionSchema = z.object({
  title: z.string().max(200),
  children: z.array(z.string().max(200)).max(50),
});

export const createWeeklyTemplateInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  frequency: z.literal("weekly"),
  sendTime: z.string().min(1).max(10),
  sendWeekday: z.number().int().min(1).max(7),
  scheduleEnabled: z.boolean(),
  sections: z.array(templateSectionSchema).max(50),
  allMembers: z.boolean(),
  recipientUserIds: z.array(z.uuid()).max(2_000),
});

export const updateWeeklyTemplateInputSchema = createWeeklyTemplateInputSchema.extend({
  templateId: z.uuid(),
});

export const submitCollectPlanInputSchema = z.object({
  reportId: z.uuid(),
  windowKind: z.enum(["week", "month", "quarter", "year", "custom"]),
  year: z.number().int().optional(),
  week: z.number().int().optional(),
  month: z.number().int().optional(),
  quarter: z.number().int().optional(),
  customStart: z.string().max(32).optional(),
  customEnd: z.string().max(32).optional(),
  computers: z
    .array(
      z.object({
        computerId: z.uuid(),
        scanPaths: z.array(z.string().max(1_024)).max(50),
      }),
    )
    .min(1)
    .max(50),
});

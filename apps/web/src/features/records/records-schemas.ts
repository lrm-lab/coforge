import { z } from "zod";
import type { ReportContent } from "./records-content";

export const reportContentSchema: z.ZodType<ReportContent> = z.object({
  tabs: z.record(z.string(), z.object({ markdown: z.string() })),
  markdown: z.string().optional(),
  assignment: z.object({ unread: z.boolean() }).optional(),
});

export const saveRecordNoteInputSchema = z.object({
  noteId: z.uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().optional(),
});

export const updateFormatReportMetaInputSchema = z.object({
  reportId: z.uuid(),
  title: z.string().trim().min(1),
});

export const saveKeyPointPromptsInputSchema = z.object({
  slot: z.enum(["team", "personal"]),
  text: z.string(),
});

export const templateSectionSchema = z.object({
  title: z.string(),
  children: z.array(z.string()),
});

export const createWeeklyTemplateInputSchema = z.object({
  name: z.string().trim().min(1),
  frequency: z.literal("weekly"),
  sendTime: z.string().min(1),
  sendWeekday: z.number().int().min(1).max(7),
  scheduleEnabled: z.boolean(),
  sections: z.array(templateSectionSchema),
  allMembers: z.boolean(),
  recipientUserIds: z.array(z.uuid()),
});

export const updateWeeklyTemplateInputSchema = z.object({
  templateId: z.uuid(),
  name: z.string().trim().min(1),
  frequency: z.literal("weekly"),
  sendTime: z.string().min(1),
  sendWeekday: z.number().int().min(1).max(7),
  scheduleEnabled: z.boolean(),
  sections: z.array(templateSectionSchema),
  allMembers: z.boolean(),
  recipientUserIds: z.array(z.uuid()),
});

export const submitCollectPlanInputSchema = z.object({
  reportId: z.uuid(),
  windowKind: z.enum(["week", "month", "quarter", "year", "custom"]),
  year: z.number().int().optional(),
  week: z.number().int().optional(),
  month: z.number().int().optional(),
  quarter: z.number().int().optional(),
  customStart: z.string().optional(),
  customEnd: z.string().optional(),
  computers: z
    .array(
      z.object({
        computerId: z.uuid(),
        scanPaths: z.array(z.string()),
      }),
    )
    .min(1),
});

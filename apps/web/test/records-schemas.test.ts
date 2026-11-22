import { describe, expect, test } from "bun:test";
import {
  createWeeklyTemplateInputSchema,
  reportContentSchema,
  saveKeyPointPromptsInputSchema,
  saveRecordNoteInputSchema,
  submitCollectPlanInputSchema,
  updateFormatReportMetaInputSchema,
} from "../src/features/records/records-schemas";

const SAMPLE_UUID = "00000000-0000-4000-8000-000000000001";

describe("records server input bounds", () => {
  test("reportContentSchema accepts normal multi-tab content and rejects oversized payloads", () => {
    expect(
      reportContentSchema.safeParse({
        tabs: { Summary: { markdown: " Shipped fix " } },
        tabOrder: ["Summary"],
      }).success,
    ).toBe(true);

    expect(
      reportContentSchema.safeParse({
        tabs: { ["x".repeat(201)]: { markdown: "ok" } },
      }).success,
    ).toBe(false);

    expect(
      reportContentSchema.safeParse({
        tabs: { Summary: { markdown: "x".repeat(200_001) } },
      }).success,
    ).toBe(false);

    const tooManyTabs = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [`Tab ${index}`, { markdown: "ok" }]),
    );
    expect(reportContentSchema.safeParse({ tabs: tooManyTabs }).success).toBe(false);
  });

  test("saveRecordNoteInputSchema and saveKeyPointPromptsInputSchema bound body and prompt length", () => {
    expect(
      saveRecordNoteInputSchema.safeParse({
        noteId: SAMPLE_UUID,
        title: "Meeting note",
        body: "ok",
      }).success,
    ).toBe(true);

    expect(
      saveRecordNoteInputSchema.safeParse({
        noteId: SAMPLE_UUID,
        body: "x".repeat(200_001),
      }).success,
    ).toBe(false);

    expect(
      saveKeyPointPromptsInputSchema.safeParse({
        slot: "team",
        text: "x".repeat(20_001),
      }).success,
    ).toBe(false);
  });

  test("updateFormatReportMetaInputSchema and createWeeklyTemplateInputSchema enforce name, section, and recipient bounds", () => {
    expect(
      updateFormatReportMetaInputSchema.safeParse({
        reportId: SAMPLE_UUID,
        title: "x".repeat(101),
      }).success,
    ).toBe(false);

    expect(
      createWeeklyTemplateInputSchema.safeParse({
        name: "Weekly sync",
        frequency: "weekly",
        sendTime: "15:00",
        sendWeekday: 5,
        scheduleEnabled: true,
        sections: [{ title: "Progress", children: ["Completed"] }],
        allMembers: false,
        recipientUserIds: [SAMPLE_UUID],
      }).success,
    ).toBe(true);

    expect(
      createWeeklyTemplateInputSchema.safeParse({
        name: "x".repeat(101),
        frequency: "weekly",
        sendTime: "15:00",
        sendWeekday: 5,
        scheduleEnabled: true,
        sections: [],
        allMembers: true,
        recipientUserIds: [],
      }).success,
    ).toBe(false);

    expect(
      createWeeklyTemplateInputSchema.safeParse({
        name: "Weekly sync",
        frequency: "weekly",
        sendTime: "15:00",
        sendWeekday: 5,
        scheduleEnabled: true,
        sections: Array.from({ length: 51 }, (_, index) => ({
          title: `Section ${index}`,
          children: [],
        })),
        allMembers: true,
        recipientUserIds: [],
      }).success,
    ).toBe(false);

    expect(
      createWeeklyTemplateInputSchema.safeParse({
        name: "Weekly sync",
        frequency: "weekly",
        sendTime: "15:00",
        sendWeekday: 5,
        scheduleEnabled: true,
        sections: [],
        allMembers: false,
        recipientUserIds: Array.from({ length: 2_001 }, () => SAMPLE_UUID),
      }).success,
    ).toBe(false);
  });

  test("submitCollectPlanInputSchema bounds computers and scanPaths", () => {
    expect(
      submitCollectPlanInputSchema.safeParse({
        reportId: SAMPLE_UUID,
        windowKind: "week",
        year: 2026,
        week: 46,
        computers: [{ computerId: SAMPLE_UUID, scanPaths: ["~/Code"] }],
      }).success,
    ).toBe(true);

    expect(
      submitCollectPlanInputSchema.safeParse({
        reportId: SAMPLE_UUID,
        windowKind: "week",
        computers: [{ computerId: SAMPLE_UUID, scanPaths: ["x".repeat(1_025)] }],
      }).success,
    ).toBe(false);
  });
});

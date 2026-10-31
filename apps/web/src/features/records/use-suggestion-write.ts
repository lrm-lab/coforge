import { useServerFn } from "@tanstack/react-start";

import type { WeeklyReportAssistantSuggestion } from "#src/server/records/weekly-report-assistant-suggestion.server";
import type { ReportBodyRestoreView, ReportContent } from "./records-content";
import {
  applyConfirmedKeyPointMarkdown,
  applyConfirmedWeeklyReportBody,
  createWeeklyTemplate,
} from "./records.functions";
import { useRecordRefresh } from "./use-record-refresh";

/** A suggestion of the weekly report assistant that writes something once confirmed. */
export type WritingSuggestion = Extract<
  WeeklyReportAssistantSuggestion,
  { type: "template-create" | "key-point-edit" | "body-edit" }
>;

export function isWritingSuggestion(
  suggestion: WeeklyReportAssistantSuggestion,
): suggestion is WritingSuggestion {
  return (
    suggestion.type === "template-create" ||
    suggestion.type === "key-point-edit" ||
    suggestion.type === "body-edit"
  );
}

/**
 * Writes what a confirmed suggestion asks for: a new format, a report's key points, or its body.
 * Resolves to the reload of what the write changed, for the panel to run once it has marked the
 * suggestion applied.
 */
export function useSuggestionWrite(
  onBodyApplied?: (
    reportId: string,
    content: ReportContent,
    restore?: ReportBodyRestoreView | null,
  ) => void,
) {
  const refresh = useRecordRefresh();
  const applyBody = useServerFn(applyConfirmedWeeklyReportBody);
  const applyKeyPoints = useServerFn(applyConfirmedKeyPointMarkdown);
  return async function writeSuggestion(messageId: string, suggestion: WritingSuggestion) {
    if (suggestion.type === "template-create") {
      await createWeeklyTemplate({
        data: {
          name: suggestion.name,
          frequency: "weekly",
          sendTime: suggestion.sendTime,
          sendWeekday: suggestion.sendWeekday,
          scheduleEnabled: suggestion.scheduleEnabled,
          sections: suggestion.sections,
          allMembers: suggestion.allMembers,
          recipientUserIds: suggestion.recipientUserIds,
        },
      });
      return refresh.records;
    }
    if (suggestion.type === "key-point-edit") {
      await applyKeyPoints({
        data: {
          reportId: suggestion.reportId,
          markdown: suggestion.markdown,
        },
      });
      return refresh.record;
    }
    const written = await applyBody({
      data: {
        reportId: suggestion.reportId,
        content: suggestion.content as ReportContent,
        sourceMessageId: messageId,
      },
    });
    onBodyApplied?.(suggestion.reportId, written.content, written.bodyRestoreView);
    // A format's body edit can cancel this week's automatic send and is its settings' outline.
    return refresh.records;
  };
}

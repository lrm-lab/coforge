import {
  normalizeReportContent,
  withOptionalMeta,
  type KeyPointExtractionMeta,
  type KeyPointPromptsMeta,
  type ReportContent,
} from "./records-content";

export function withKeyPointPrompts(
  content: ReportContent,
  prompts: KeyPointPromptsMeta,
): ReportContent {
  const normalized = normalizeReportContent(content);
  return withOptionalMeta(
    normalized,
    normalized.assignment,
    normalized.schedule,
    prompts,
    normalized.keyPointExtraction,
  );
}

export function withKeyPointExtraction(
  content: ReportContent,
  extraction: KeyPointExtractionMeta,
): ReportContent {
  const normalized = normalizeReportContent(content);
  return withOptionalMeta(
    normalized,
    normalized.assignment,
    normalized.schedule,
    normalized.keyPointPrompts,
    extraction,
  );
}

export function isAssignmentUnread(content: ReportContent): boolean {
  return normalizeReportContent(content).assignment?.unread === true;
}

export function withAssignmentUnread(content: ReportContent, unread: boolean): ReportContent {
  const normalized = normalizeReportContent(content);
  return withOptionalMeta(
    normalized,
    { unread },
    normalized.schedule,
    normalized.keyPointPrompts,
    normalized.keyPointExtraction,
  );
}

export function isAutoSendCancelled(content: ReportContent, year: number, week: number): boolean {
  const schedule = normalizeReportContent(content).schedule;
  return schedule?.cancelledYear === year && schedule?.cancelledWeek === week;
}

export function isWeekSendDismissed(content: ReportContent, year: number, week: number): boolean {
  const schedule = normalizeReportContent(content).schedule;
  return (
    schedule?.dismissSend === true &&
    schedule.cancelledYear === year &&
    schedule.cancelledWeek === week
  );
}

export function withAutoSendCancelled(
  content: ReportContent,
  year: number,
  week: number,
): ReportContent {
  const normalized = normalizeReportContent(content);
  const prior = normalized.schedule;
  return withOptionalMeta(
    normalized,
    normalized.assignment,
    {
      cancelledYear: year,
      cancelledWeek: week,
      ...(prior?.dismissSend && prior.cancelledYear === year && prior.cancelledWeek === week
        ? { dismissSend: true }
        : {}),
    },
    normalized.keyPointPrompts,
    normalized.keyPointExtraction,
  );
}

export function withoutWeekSendDismissed(
  content: ReportContent,
  year: number,
  week: number,
): ReportContent {
  const normalized = normalizeReportContent(content);
  if (!isAutoSendCancelled(normalized, year, week)) return normalized;
  const { schedule: _schedule, ...rest } = normalized;
  return rest;
}

export function withWeekSendDismissed(
  content: ReportContent,
  year: number,
  week: number,
): ReportContent {
  const normalized = normalizeReportContent(content);
  return withOptionalMeta(
    normalized,
    normalized.assignment,
    {
      cancelledYear: year,
      cancelledWeek: week,
      dismissSend: true,
    },
    normalized.keyPointPrompts,
    normalized.keyPointExtraction,
  );
}

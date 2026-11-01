import { normalizeReportContent } from "#src/features/records/records-content";

/** Canonical report-content coercion for server modules that read persisted JSON. */
export const asReportContent = normalizeReportContent;

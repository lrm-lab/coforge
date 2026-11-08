import { m } from "#src/paraglide/messages";

/** What a Records request was for, so a refusal reads in terms of that. */
type RecordsErrorContext = "save" | "collect";

const COPY = {
  save: {
    notFound: m.records_report_save_not_found,
    accessDenied: m.records_report_save_access_denied,
    invalid: m.records_report_save_invalid,
  },
  collect: {
    notFound: m.records_collect_plan_not_found,
    accessDenied: m.records_collect_plan_access_denied,
    invalid: m.records_collect_plan_invalid,
  },
} as const;

/**
 * Our own server's refusal of a Records request, worded for the person: what it means and, where
 * there is one, what to do. The server's error codes are not shown. A refusal this does not know
 * gives `undefined`, and the caller says only that it failed.
 */
export function recordsErrorMessage(error: unknown, context: RecordsErrorContext) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("COFORGE_APP_ERROR:NOT_FOUND")) return COPY[context].notFound();
  if (message.includes("COFORGE_APP_ERROR:ACCESS_DENIED")) return COPY[context].accessDenied();
  if (message.includes("COFORGE_APP_ERROR:INVALID_INPUT")) return COPY[context].invalid();
  if (context === "save" && isSaveConflict(error)) return m.records_report_conflict_reloaded();
  return undefined;
}

/**
 * The report was saved from somewhere else first. The page reloads it and keeps the draft, so
 * asking again carries the fresh version and can go through: the one known refusal worth a retry.
 */
export function isSaveConflict(error: unknown) {
  return error instanceof Error && error.message.includes("COFORGE_APP_ERROR:CONFLICT");
}

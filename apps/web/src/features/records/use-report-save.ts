import { useCallback, useEffect, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";

import { saveWeeklyReportContent } from "./records.functions";
import { normalizeReportContent, type ReportContent } from "./records-content";
import { trackReportSave, waitForReportSave, writeReportDraft } from "./report-draft-cache";
import { useRecordRefresh } from "./use-record-refresh";

/**
 * Starts a report save: stores the normalized body as the session draft, sends
 * it, and registers the write so a later submit or remount can wait for it.
 * It is not async on purpose: `saved` is the tracked promise itself, so a
 * caller that ignores it (the unmount flush) leaves no unhandled rejection.
 */
export function useReportDraftSave() {
  const save = useServerFn(saveWeeklyReportContent);
  return useCallback(
    (
      reportId: string,
      content: ReportContent,
      options?: { status?: "draft" | "submitted" | "shared"; askToSend?: boolean },
    ) => {
      const normalized = normalizeReportContent(content);
      writeReportDraft(reportId, normalized);
      const saved = save({
        data: {
          reportId,
          content: normalized,
          status: options?.status,
          askToSend: options?.askToSend,
        },
      });
      trackReportSave(reportId, saved);
      return { normalized, saved };
    },
    [save],
  );
}

/**
 * A save started before this detail mounted (the previous one unmounting
 * flushes its edits) may still be in flight. When it settles, `onSettled`
 * picks up the draft it left behind and the Records pages are reloaded. It
 * looks again whenever `watch` changes, for a save started since.
 */
export function useSettledReportSave(reportId: string, watch: unknown, onSettled: () => void) {
  const refresh = useRecordRefresh();
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  useEffect(() => {
    let cancelled = false;
    void waitForReportSave(reportId)?.then(() => {
      if (cancelled) return;
      onSettledRef.current();
      void refresh.records();
    });
    return () => {
      cancelled = true;
    };
  }, [reportId, watch, refresh]);
}

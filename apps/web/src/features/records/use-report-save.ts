import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { saveWeeklyReportContent } from "./records.functions";
import { normalizeReportContent, type ReportContent } from "./records-content";
import { trackReportSave, waitForReportSave, writeReportDraft } from "./report-draft-cache";

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
 * picks up the draft it left behind and the catalog is reloaded.
 */
export function useSettledReportSave(reportId: string, onSettled: () => void) {
  const router = useRouter();
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  useEffect(() => {
    let cancelled = false;
    void waitForReportSave(reportId)?.then(() => {
      if (cancelled) return;
      onSettledRef.current();
      void router.invalidate();
    });
    return () => {
      cancelled = true;
    };
  }, [reportId, router]);
}

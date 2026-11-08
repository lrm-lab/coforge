import { useCallback, useState } from "react";

import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import { isSaveConflict, recordsErrorMessage } from "./records-error-message";

/**
 * A save that did not go through. The server's refusals we know (the report is gone, no longer
 * yours) are worded and have no `retry`: asking again gets the same answer. A conflict is worded
 * and keeps its `retry`: the page has reloaded the report, so the retry carries the fresh version.
 * Any other failure, a dropped connection among them, may pass next time and keeps its `retry`.
 */
export type ReportSaveFailure = { message: string | undefined; retry: (() => void) | undefined };

export function reportSaveFailure(cause: unknown, retry: () => void): ReportSaveFailure {
  const message = recordsErrorMessage(cause, "save");
  return { message, retry: message && !isSaveConflict(cause) ? undefined : retry };
}

/**
 * What a report page knows about its saves: how many are in flight (autosave and a send can
 * overlap, and the first to end must not clear the other's), and the last one that failed, until
 * a later save goes through. Both report pages save through `track`.
 */
export function useReportSaveState() {
  const [inFlight, setInFlight] = useState(0);
  const [failure, setFailure] = useState<ReportSaveFailure | null>(null);
  /** Counts a save as started; the function it returns counts it as ended. */
  const begin = useCallback(() => {
    setInFlight((count) => count + 1);
    return () => setInFlight((count) => count - 1);
  }, []);
  /**
   * Runs one save, counted. A refusal becomes `failure` (when `isCurrent`: the page has not moved
   * on to another report) with `retry` to ask again, and the call answers `false`; a save that goes
   * through clears the failure and answers `true`. `onFailure` hears what was thrown.
   */
  const track = useCallback(
    async (
      work: () => Promise<unknown>,
      retry: () => void,
      isCurrent: () => boolean = () => true,
      onFailure?: (cause: unknown) => void,
    ) => {
      const end = begin();
      try {
        await work();
        if (isCurrent()) setFailure(null);
        return true;
      } catch (cause) {
        if (isCurrent()) {
          setFailure(reportSaveFailure(cause, retry));
          onFailure?.(cause);
        }
        return false;
      } finally {
        end();
      }
    },
    [begin],
  );
  return { saving: inFlight > 0, failure, setFailure, begin, track };
}

/** The refusal worded for the person, with the way to ask again where asking can help; the edits stay in the editor. */
export function ReportSaveFailureBar({
  failure,
  retrying,
}: {
  failure: ReportSaveFailure;
  retrying: boolean;
}) {
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center gap-3 border-b border-secondary bg-error-primary px-4 py-2 text-sm text-primary md:px-6"
    >
      <div className="min-w-0 flex-1">
        <p className="break-words">
          <span className="font-medium">{m.records_report_save_failed()}</span>
          {failure.message && <> · {failure.message}</>}
        </p>
        {/* Nothing to ask again: the words are all that is left of the edits, so they say so. */}
        {!failure.retry && (
          <p className="break-words text-tertiary">{m.records_report_save_keep_text()}</p>
        )}
      </div>
      {failure.retry && (
        <Button color="secondary" size="sm" isLoading={retrying} onPress={failure.retry}>
          {m.controls_retry()}
        </Button>
      )}
    </div>
  );
}

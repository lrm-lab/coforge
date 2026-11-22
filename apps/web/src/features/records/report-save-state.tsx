import { useCallback, useState } from "react";

import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import { isSaveConflict, recordsErrorMessage } from "./records-error-message";

export type ReportSaveFailure = { message: string | undefined; retry: (() => void) | undefined };

export function reportSaveFailure(cause: unknown, retry: () => void): ReportSaveFailure {
  const message = recordsErrorMessage(cause, "save");
  return { message, retry: message && !isSaveConflict(cause) ? undefined : retry };
}

export function useReportSaveState() {
  const [inFlight, setInFlight] = useState(0);
  const [failure, setFailure] = useState<ReportSaveFailure | null>(null);
  const begin = useCallback(() => {
    setInFlight((count) => count + 1);
    return () => setInFlight((count) => count - 1);
  }, []);
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
          {failure.message ? (
            <>
              {" "}
              <span className="ms-1 text-secondary">{failure.message}</span>
            </>
          ) : null}
        </p>
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

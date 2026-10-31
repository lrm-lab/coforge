import { useEffect, useRef } from "react";

import { useRecordRefresh } from "./use-record-refresh";
import type { WeeklyReportAssistantMessage } from "./weekly-report-assistant-session";

/**
 * The assistant's newest body edit was written to the report before its message arrived: once per
 * such message, read the report again (it alone) so the page shows the edited body.
 * `appliedMessageId` is the edit the page already shows (its restore view's source), which needs
 * no read.
 */
export function useBodyEditRefresh(
  assistantMessages: readonly WeeklyReportAssistantMessage[],
  appliedMessageId: string | undefined,
) {
  const refresh = useRecordRefresh();
  const refreshedFor = useRef<string | null>(null);
  useEffect(() => {
    const latest = [...assistantMessages]
      .reverse()
      .find((message) => message.suggestion?.type === "body-edit");
    if (!latest || latest.id === appliedMessageId) return;
    if (refreshedFor.current === latest.id) return;
    refreshedFor.current = latest.id;
    void refresh.record();
  }, [assistantMessages, appliedMessageId, refresh]);
}

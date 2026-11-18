import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { m } from "#src/paraglide/messages";
import { startTeamKeyPointExtraction } from "./records.functions";
import { KeyPointStartRefusal } from "./team-key-point-section";
import { useRecordRefresh } from "./use-record-refresh";

export function useTeamKeyPointStart(overviewReportId: string, canStart: boolean) {
  const startTeamKeyPoints = useServerFn(startTeamKeyPointExtraction);
  const refresh = useRecordRefresh();
  const [busy, setBusy] = useState(false);

  async function start() {
    if (!canStart || busy) return;
    setBusy(true);
    try {
      const result = await startTeamKeyPoints({
        data: { overviewReportId, force: true },
      });
      if (result.error === "no_submitted_member_reports")
        throw new KeyPointStartRefusal(m.records_key_points_team_none_submitted());
      await refresh.record();
    } finally {
      setBusy(false);
    }
  }

  return { busy, start };
}

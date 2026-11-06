import { useEffect, useState } from "react";

import { useBreakpoint } from "#src/hooks/use-breakpoint";

import { sidePanelOpensOnEntry, type RecordSideSurface } from "./record-side-panel-pin";

/** Whether the report's side chat is open; follows the pinned choice when the report changes. */
export function useReportSidePanelOpen(reportId: string, surface: RecordSideSurface) {
  const beside = useBreakpoint("lg");
  const [open, setOpen] = useState(() =>
    sidePanelOpensOnEntry("report", reportId, surface, beside),
  );
  useEffect(() => {
    setOpen(sidePanelOpensOnEntry("report", reportId, surface, beside));
  }, [reportId, surface, beside]);
  return [open, setOpen] as const;
}

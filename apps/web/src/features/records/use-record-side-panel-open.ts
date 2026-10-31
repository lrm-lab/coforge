import { useEffect, useState } from "react";

import { readSidePanelPinned, type RecordSideSurface } from "./record-side-panel-pin";

/** Whether the report's side chat is open; follows the pinned choice when the report changes. */
export function useReportSidePanelOpen(reportId: string, surface: RecordSideSurface) {
  const [open, setOpen] = useState(() => readSidePanelPinned("report", reportId, surface));
  useEffect(() => {
    setOpen(readSidePanelPinned("report", reportId, surface));
  }, [reportId, surface]);
  return [open, setOpen] as const;
}

import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { useRecordRefresh } from "./use-record-refresh";

/** Open state for a `ConfirmDialog` that confirms a Records delete. */
export function useRecordDeleteDialog() {
  const [open, setOpen] = useState(false);
  return {
    open,
    setOpen,
    request: () => setOpen(true),
    close: () => setOpen(false),
  };
}

/** After a report or week is deleted: reload the catalog, then go back to the Records list. */
export function useLeaveToRecordsList() {
  const refresh = useRecordRefresh();
  const navigate = useNavigate();
  const workspaceSlug = useWorkspaceSlug();
  return async () => {
    await refresh.records();
    void navigate({
      to: "/w/$workspaceSlug/records",
      params: { workspaceSlug },
      search: (previous) => ({
        tab: previous.tab === "notes" ? "notes" : "weekly",
      }),
    });
  };
}

import { useState } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";

import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";

/** State for a `RecordsDeleteConfirmDialog`: closing the dialog also drops a stale error. */
export function useRecordDeleteDialog() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  return {
    open,
    error,
    setError,
    request() {
      setError("");
      setOpen(true);
    },
    close: () => setOpen(false),
    onOpenChange(next: boolean) {
      setOpen(next);
      setError("");
    },
  };
}

/** After a report or week is deleted: reload the catalog, then go back to the Records list. */
export function useLeaveToRecordsList() {
  const router = useRouter();
  const navigate = useNavigate();
  const workspaceSlug = useWorkspaceSlug();
  return async () => {
    await router.invalidate({ sync: true });
    void navigate({
      to: "/w/$workspaceSlug/records",
      params: { workspaceSlug },
      search: (previous) => ({
        tab: previous.tab === "notes" ? "notes" : "weekly",
      }),
    });
  };
}

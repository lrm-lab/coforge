import { useState } from "react";
import { FolderSearch } from "@untitledui/icons";
import { useHydrated } from "@tanstack/react-router";

import { Button } from "#src/components/base/buttons/button";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { formatDateForDisplay } from "#src/lib/dates";
import { getLocale } from "#src/paraglide/runtime";
import { m } from "#src/paraglide/messages";
import { DetailGroup } from "./computer-detail-rows";
import { formatWorkspaceSize } from "./workspace-size";
import type { ComputerAgentWorkspaceScan } from "./computer.schemas";
import type { AgentWorkspaceScanSnapshot } from "./agent-workspace-scan.query";

export function ComputerDetailWorkspaceInventory({
  snapshot,
  status,
  timeZone,
  canScan,
  onScan,
  canDelete,
  onDelete,
}: {
  snapshot: AgentWorkspaceScanSnapshot | null;
  status: "idle" | "scanning" | "error";
  timeZone: string | null;
  canScan: boolean;
  onScan: () => void;
  canDelete: boolean;
  onDelete: (agentId: string) => Promise<void>;
}) {
  const [deleteTarget, setDeleteTarget] = useState<ComputerAgentWorkspaceScan | undefined>();
  const hydrated = useHydrated();
  const deletedCount = snapshot
    ? snapshot.workspaces.filter((item) => item.state === "deleted").length
    : 0;
  return (
    <DetailGroup
      heading={m.computer_agent_workspaces()}
      headingId="computer-agent-workspaces"
      action={
        canScan ? (
          <Button
            type="button"
            size="sm"
            color="secondary"
            iconLeading={FolderSearch}
            isLoading={status === "scanning"}
            showTextWhileLoading
            onPress={onScan}
          >
            {status === "scanning"
              ? m.computer_agent_workspaces_scanning()
              : m.computer_agent_workspaces_scan()}
          </Button>
        ) : undefined
      }
    >
      {status === "scanning" && (
        <p role="status" className="sr-only">
          {m.computer_agent_workspaces_scanning()}
        </p>
      )}
      {status === "error" && (
        <p role="alert" className="py-2 text-sm text-error-primary">
          {m.computer_agent_workspaces_error()}
        </p>
      )}
      {snapshot && (
        <p className="pt-3 text-xs text-tertiary">
          <time dateTime={new Date(snapshot.scannedAt).toISOString()}>
            {m.computer_agent_workspaces_scanned_at({
              // The viewer's saved zone and the UI language (`lib/AGENTS.md`); the server render
              // knows neither, so the time appears once the page is hydrated.
              date: hydrated
                ? formatDateForDisplay(new Date(snapshot.scannedAt), timeZone, getLocale())
                : "",
            })}
          </time>
        </p>
      )}
      {snapshot &&
        (snapshot.workspaces.length ? (
          <>
            {deletedCount > 0 && (
              <p className="py-3 text-sm text-tertiary">
                {m.computer_agent_workspaces_deleted_summary({ count: String(deletedCount) })}
              </p>
            )}
            <ul className="divide-y divide-secondary">
              {snapshot.workspaces.map((workspace) => (
                <li
                  key={workspace.agentId}
                  className="flex min-w-0 items-start justify-between gap-4 py-3 text-sm"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-primary">
                        {workspace.displayName}
                      </span>
                      <span className="rounded-md bg-secondary px-1.5 py-0.5 text-xs font-medium text-tertiary">
                        {workspace.state === "deleted"
                          ? m.computer_agent_workspace_deleted()
                          : m.computer_agent_workspace_active()}
                      </span>
                    </div>
                    <p className="mt-1 truncate font-mono text-xs text-tertiary">
                      {workspace.rootPath}
                    </p>
                    <p className="mt-1 text-xs text-tertiary">
                      {workspace.status === "present"
                        ? m.computer_agent_workspace_stats({
                            files: String(workspace.fileCount),
                            size: formatWorkspaceSize(workspace.totalSizeBytes),
                          })
                        : workspace.status === "missing"
                          ? m.computer_agent_workspace_missing()
                          : workspace.status === "partial"
                            ? m.computer_agent_workspace_partial()
                            : m.computer_agent_workspace_unavailable()}
                    </p>
                    {workspace.modifiedAtMs > 0 && (
                      <p className="mt-1 text-xs text-tertiary">
                        {m.computer_agent_workspace_modified({
                          date: new Date(workspace.modifiedAtMs).toLocaleString(),
                        })}
                      </p>
                    )}
                  </div>
                  {canDelete && (
                    <Button
                      type="button"
                      size="sm"
                      color="tertiary-destructive"
                      isDisabled={workspace.status !== "present" && workspace.status !== "partial"}
                      onPress={() => setDeleteTarget(workspace)}
                    >
                      {m.computer_agent_workspace_delete()}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="py-2 text-sm text-tertiary">{m.computer_agent_workspaces_none()}</p>
        ))}
      <ConfirmDialog
        open={deleteTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(undefined);
        }}
        title={m.computer_agent_workspace_delete_title({ name: deleteTarget?.displayName ?? "" })}
        description={m.computer_agent_workspace_delete_description()}
        confirmLabel={m.computer_agent_workspace_delete()}
        errorMessage={m.computer_agent_workspace_delete_error()}
        onConfirm={async () => {
          if (!deleteTarget) return;
          await onDelete(deleteTarget.agentId);
          setDeleteTarget(undefined);
        }}
      />
    </DetailGroup>
  );
}

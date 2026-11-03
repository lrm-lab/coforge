import { useRef } from "react";
import { useHydrated } from "@tanstack/react-router";
import { FolderSearch, Trash01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Popconfirm } from "#src/components/ui/popconfirm";
import { m } from "#src/paraglide/messages";
import { isAppErrorCode } from "#src/lib/app-error";
import { formatCalendarDate } from "#src/lib/dates";
import { getLocale } from "#src/paraglide/runtime";
import { formatWorkspaceSize } from "./workspace-size";
import { DetailGroup } from "./computer-detail-rows";
import type { ComputerAgentWorkspaceScan } from "./computer.schemas";
import type { AgentWorkspaceScanSnapshot } from "./agent-workspace-scan.query";

export function ComputerDetailWorkspaceInventory({
  snapshot,
  status,
  canScan,
  onScan,
  canDelete,
  onDelete,
  timeZone,
}: {
  snapshot: AgentWorkspaceScanSnapshot | null;
  status: "idle" | "scanning" | "error";
  canScan: boolean;
  onScan: () => void;
  canDelete: boolean;
  onDelete: (agentId: string) => Promise<void>;
  timeZone: string | null;
}) {
  const hydrated = useHydrated();
  // Where focus lands after a deleted workspace's row (and its button) is gone.
  const listRef = useRef<HTMLDivElement>(null);
  // The Computer did not answer: every Agent keeps a row without a directory, said once above.
  const unanswered = snapshot?.workspaces.some((item) => item.status === "unavailable") ?? false;
  // Only a directory the Computer listed is known to remain on disk.
  const deletedCount = snapshot
    ? snapshot.workspaces.filter((item) => item.state === "deleted" && item.status === "present")
        .length
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
              : snapshot
                ? m.computer_agent_workspaces_rescan()
                : m.computer_agent_workspaces_scan()}
          </Button>
        ) : undefined
      }
    >
      <div ref={listRef} tabIndex={-1} className="outline-hidden">
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
        {snapshot &&
          (snapshot.workspaces.length ? (
            <>
              {unanswered ? (
                <p className="py-3 text-sm text-tertiary">
                  {m.computer_agent_workspace_unavailable()}
                </p>
              ) : (
                deletedCount > 0 && (
                  <p className="py-3 text-sm text-tertiary">
                    {m.computer_agent_workspaces_deleted_summary({ count: String(deletedCount) })}
                  </p>
                )
              )}
              <ul className="divide-y divide-secondary">
                {snapshot.workspaces.map((workspace) => (
                  <li
                    key={workspace.agentId}
                    className="flex min-w-0 items-center justify-between gap-4 py-3 text-sm"
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
                      {workspace.status === "present" && (
                        <>
                          <p className="mt-1 truncate font-mono text-xs text-tertiary">
                            {workspace.rootPath}
                          </p>
                          <p className="mt-1 truncate text-xs text-tertiary">
                            {workspaceStatistics(workspace)}
                            {hydrated &&
                              workspace.modifiedAtMs > 0 &&
                              ` · ${m.computer_agent_workspace_modified({
                                date: formatCalendarDate(
                                  new Date(workspace.modifiedAtMs),
                                  timeZone,
                                  getLocale(),
                                ),
                              })}`}
                          </p>
                        </>
                      )}
                    </div>
                    {canDelete && (
                      // Deleting does not depend on the scan answering, as on an archived Agent's
                      // profile.
                      <Popconfirm
                        title={m.computer_agent_workspace_delete_title({
                          name: workspace.displayName,
                        })}
                        description={m.computer_agent_workspace_delete_description()}
                        confirmLabel={m.computer_agent_workspace_delete()}
                        errorMessage={deleteErrorMessage}
                        placement="bottom end"
                        fallbackFocus={() => listRef.current}
                        onConfirm={() => onDelete(workspace.agentId)}
                      >
                        <ButtonUtility
                          color="secondary"
                          icon={Trash01}
                          tooltip={m.computer_agent_workspace_delete()}
                        />
                      </Popconfirm>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="py-2 text-sm text-tertiary">{m.computer_agent_workspaces_none()}</p>
          ))}
      </div>
    </DetailGroup>
  );
}

/** A present workspace's size and file count as far as the Computer measured them. */
function workspaceStatistics(workspace: ComputerAgentWorkspaceScan): string {
  const counts = {
    files: new Intl.NumberFormat(getLocale()).format(workspace.fileCount),
    size: formatWorkspaceSize(workspace.totalSizeBytes),
  };
  switch (workspace.statisticsStatus) {
    case "pending":
      return m.computer_agent_workspace_stats_pending();
    case "complete":
      return m.computer_agent_workspace_stats(counts);
    // The measurement stopped at its budget: what it reached is a lower bound.
    case "truncated":
      return m.computer_agent_workspace_stats_truncated(counts);
    case "skipped":
    case "unavailable":
      return "—";
  }
}

/** Why the delete failed, in the words ui settled on; anything unrecognised keeps the old line. */
function deleteErrorMessage(cause: unknown): string {
  if (isAppErrorCode(cause, "INVALID_INPUT", "TEMPORARILY_UNAVAILABLE") && cause.errorId) {
    switch (cause.errorId) {
      case "agent-workspace-delete-offline":
        return m.computer_agent_workspace_delete_offline();
      case "agent-workspace-delete-timeout":
        return m.computer_agent_workspace_delete_timeout();
      case "agent-workspace-delete-busy":
        return m.computer_agent_workspace_delete_busy();
      case "agent-workspace-delete-denied":
        return m.computer_agent_workspace_delete_denied();
    }
  }
  return m.computer_agent_workspace_delete_error();
}

import { useRef, useState } from "react";
import { useHydrated } from "@tanstack/react-router";
import { RefreshCw01, Trash01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { formatDisplayPath } from "#src/features/agents/display-path";
import { isAppErrorCode } from "#src/lib/app-error";
import { formatCalendarDate } from "#src/lib/dates";
import { formatNumber } from "#src/lib/format-number";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import type { AgentWorkspaceScanSnapshot } from "./agent-workspace-scan.query";
import { isValidComputerDate } from "./computer-detail-date";
import type { ComputerAgentWorkspaceScan } from "./computer.schemas";
import { formatWorkspaceSize } from "./workspace-size";

const WORKSPACE_INVENTORY_PAGE_SIZE = 50;

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
  const listRef = useRef<HTMLDivElement>(null);
  const [deleting, setDeleting] = useState<ComputerAgentWorkspaceScan | null>(null);
  const [visibleCount, setVisibleCount] = useState(WORKSPACE_INVENTORY_PAGE_SIZE);
  const workspaces = snapshot?.workspaces ?? [];
  const visibleWorkspaces = workspaces.slice(0, visibleCount);
  const hiddenCount = Math.max(0, workspaces.length - visibleWorkspaces.length);
  const unanswered = workspaces.some((item) => item.status === "unavailable");
  const deletedCount = workspaces.filter(
    (item) => item.state === "deleted" && item.status === "present",
  ).length;
  const hasBody = status !== "idle" || snapshot !== null;

  return (
    <>
      <section aria-labelledby="computer-agent-workspaces">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 id="computer-agent-workspaces" className="text-xs font-semibold text-primary">
              {m.computer_detail_cleanup_title()}
            </h3>
            <p className="mt-0.5 text-xs text-tertiary">
              {m.computer_detail_cleanup_description()}
            </p>
          </div>
          {canScan ? (
            <Button
              type="button"
              size="xs"
              color="secondary"
              iconLeading={RefreshCw01}
              isLoading={status === "scanning"}
              showTextWhileLoading
              className="shrink-0"
              onPress={onScan}
            >
              {status === "scanning"
                ? m.computer_agent_workspaces_scanning()
                : snapshot
                  ? m.computer_agent_workspaces_rescan()
                  : m.computer_agent_workspaces_scan()}
            </Button>
          ) : null}
        </div>

        {hasBody ? (
          <div ref={listRef} tabIndex={-1} className="mt-2.5 outline-hidden">
            {status === "scanning" ? (
              <p role="status" className="sr-only">
                {m.computer_agent_workspaces_scanning()}
              </p>
            ) : null}
            {status === "error" ? (
              <p role="alert" className="py-1 text-xs text-error-primary">
                {m.computer_agent_workspaces_error()}
              </p>
            ) : null}
            {snapshot ? (
              snapshot.workspaces.length ? (
                <>
                  {unanswered ? (
                    <p className="py-1.5 text-xs text-tertiary">
                      {m.computer_agent_workspace_unavailable()}
                    </p>
                  ) : deletedCount > 0 ? (
                    <p className="py-1.5 text-xs text-tertiary tabular-nums">
                      {m.computer_agent_workspaces_deleted_summary({
                        count: deletedCount,
                      })}
                    </p>
                  ) : null}
                  <ul className="divide-y divide-secondary">
                    {visibleWorkspaces.map((workspace) => {
                      const shownRootPath = formatDisplayPath(workspace.rootPath);
                      const modifiedAt =
                        workspace.modifiedAtMs > 0 ? new Date(workspace.modifiedAtMs) : null;
                      const showModifiedAt = Boolean(
                        hydrated && modifiedAt && isValidComputerDate(modifiedAt),
                      );
                      return (
                        <li
                          key={workspace.agentId}
                          className="flex min-w-0 items-start justify-between gap-4 py-2.5 text-sm"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <Tooltip title={workspace.displayName}>
                                <TooltipTrigger className="max-w-full min-w-0 rounded-xs text-start outline-focus-ring focus-visible:outline-2">
                                  <span className="block truncate font-medium text-primary">
                                    <bdi>{workspace.displayName}</bdi>
                                  </span>
                                </TooltipTrigger>
                              </Tooltip>
                              <span className="shrink-0 rounded-md bg-secondary px-1.5 py-0.5 text-xs font-medium text-tertiary">
                                {workspace.state === "deleted"
                                  ? m.computer_agent_workspace_deleted()
                                  : m.computer_agent_workspace_active()}
                              </span>
                            </div>
                            {workspace.status === "present" ? (
                              <>
                                <p className="mt-1 min-w-0 font-mono text-xs text-tertiary">
                                  {shownRootPath !== workspace.rootPath ? (
                                    <Tooltip title={workspace.rootPath}>
                                      <TooltipTrigger className="max-w-full min-w-0 rounded-xs text-start outline-focus-ring focus-visible:outline-2">
                                        <span dir="ltr" className="wrap-anywhere">
                                          {shownRootPath}
                                        </span>
                                      </TooltipTrigger>
                                    </Tooltip>
                                  ) : (
                                    <span dir="ltr" className="wrap-anywhere">
                                      {workspace.rootPath}
                                    </span>
                                  )}
                                </p>
                                <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-tertiary tabular-nums">
                                  <span>{workspaceStatistics(workspace)}</span>
                                  {showModifiedAt && modifiedAt ? (
                                    <span>
                                      {m.computer_agent_workspace_modified({
                                        date: formatCalendarDate(modifiedAt, timeZone, getLocale()),
                                      })}
                                    </span>
                                  ) : null}
                                </p>
                              </>
                            ) : null}
                          </div>
                          {canDelete ? (
                            <ButtonUtility
                              color="secondary"
                              icon={Trash01}
                              className="shrink-0"
                              tooltip={m.computer_agent_workspace_delete()}
                              onClick={() => setDeleting(workspace)}
                            />
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                  {hiddenCount > 0 ? (
                    <div className="pt-2">
                      <Button
                        type="button"
                        size="xs"
                        color="secondary"
                        onPress={() =>
                          setVisibleCount((count) => count + WORKSPACE_INVENTORY_PAGE_SIZE)
                        }
                      >
                        {m.computer_detail_show_more({ remaining: formatNumber(hiddenCount) })}
                      </Button>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="py-1 text-xs text-tertiary">{m.computer_agent_workspaces_none()}</p>
              )
            ) : null}
          </div>
        ) : null}
      </section>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={m.computer_agent_workspace_delete_title({
          name: deleting?.displayName ?? "",
        })}
        description={m.computer_agent_workspace_delete_description()}
        confirmLabel={m.computer_agent_workspace_delete()}
        errorMessage={deleteErrorMessage}
        onConfirm={async () => {
          if (!deleting) return;
          await onDelete(deleting.agentId);
          setDeleting(null);
          listRef.current?.focus({ preventScroll: true });
        }}
      />
    </>
  );
}

function workspaceStatistics(workspace: ComputerAgentWorkspaceScan): string {
  const counts = {
    files: workspace.fileCount,
    size: formatWorkspaceSize(workspace.totalSizeBytes),
  };
  switch (workspace.statisticsStatus) {
    case "pending":
      return m.computer_agent_workspace_stats_pending();
    case "complete":
      return m.computer_agent_workspace_stats(counts);
    case "truncated":
      return m.computer_agent_workspace_stats_truncated(counts);
    case "skipped":
    case "unavailable":
      return "—";
  }
}

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

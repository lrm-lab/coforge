import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "#src/components/base/buttons/button";
import {
  deleteAgentWorkspace,
  scanAgentWorkspaces,
} from "#src/features/computers/computers.functions";
import {
  DeleteConfirmDialog,
  formatWorkspaceSize,
} from "#src/features/computers/confirm-delete-dialog";
import { useTimeFormat } from "#src/lib/time-format-context";
import { formatDateForDisplay } from "#src/lib/dates";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { SECTION_CAPTION_CLASS, SUBFIELD_LABEL_CLASS } from "./inline-edit-field";

type ArchiveComputer = { id: string; label: string; ownedByViewer: boolean };

/**
 * An archived Agent's ARCHIVE section, for those who managed it: when and by whom it was archived,
 * and where its workspace is. Its files stay on the Computer it ran on until someone removes them;
 * only that Computer's owner may look at them or delete them, as on the Computer page.
 */
export function AgentArchiveSection({
  agentId,
  agentName,
  deletedAt,
  deletedBy,
  computer,
  timeZone,
}: {
  agentId: string;
  agentName: string;
  deletedAt: Date | string;
  /** Who archived it, when that was recorded. */
  deletedBy: string | null;
  computer?: ArchiveComputer;
  timeZone: string | null;
}) {
  const archivedAt = formatDateForDisplay(
    new Date(deletedAt),
    timeZone,
    getLocale(),
    useTimeFormat(),
  );
  return (
    <section className="border-b border-secondary px-6 py-5">
      <p className={SECTION_CAPTION_CLASS}>{m.agent_archive_section()}</p>
      <dl className="mt-3 flex flex-col gap-4">
        <div>
          <dt className={SUBFIELD_LABEL_CLASS}>{m.agent_archive_archived_at()}</dt>
          <dd className="mt-1 text-sm font-medium text-primary">
            {deletedBy
              ? m.agent_archive_archived_at_by({ date: archivedAt, name: deletedBy })
              : archivedAt}
          </dd>
        </div>
        <div>
          <dt className={SUBFIELD_LABEL_CLASS}>{m.agent_archive_workspace()}</dt>
          {!computer ? (
            <dd className="mt-1 text-sm text-tertiary">
              {m.agent_archive_workspace_no_computer()}
            </dd>
          ) : computer.ownedByViewer ? (
            <OwnedWorkspace agentId={agentId} agentName={agentName} computer={computer} />
          ) : (
            <dd className="mt-1 text-sm text-tertiary">
              {m.agent_archive_workspace_not_owner({ computer: computer.label })}
            </dd>
          )}
        </div>
      </dl>
    </section>
  );
}

/** The workspace as its Computer reports it now, with the delete its owner may make. */
function OwnedWorkspace({
  agentId,
  agentName,
  computer,
}: {
  agentId: string;
  agentName: string;
  computer: ArchiveComputer;
}) {
  const scan = useServerFn(scanAgentWorkspaces);
  const remove = useServerFn(deleteAgentWorkspace);
  const queryClient = useQueryClient();
  const queryKey = ["archived-agent-workspace", computer.id, agentId] as const;
  // One Agent's scan reads its directories on the Computer, so it runs once per opening.
  const workspace = useQuery({
    queryKey,
    queryFn: async () =>
      (await scan({ data: { computerId: computer.id, agentId } })).find(
        (entry) => entry.agentId === agentId,
      ) ?? null,
    staleTime: Infinity,
    retry: false,
  });
  const [confirming, setConfirming] = useState(false);
  const state = workspace.data;
  const present = state?.status === "present" || state?.status === "partial";
  return (
    <>
      <dd className="mt-1 text-sm text-primary">
        {workspace.isPending
          ? m.agent_archive_workspace_checking()
          : workspace.isError || !state || state.status === "unavailable"
            ? m.agent_archive_workspace_unavailable({ computer: computer.label })
            : state.status === "missing"
              ? m.agent_archive_workspace_removed()
              : m.agent_archive_workspace_on_computer({ computer: computer.label })}
      </dd>
      {present && state.status === "present" && (
        <dd className="mt-1 text-xs text-tertiary">
          {m.computer_agent_workspace_stats({
            files: String(state.fileCount),
            size: formatWorkspaceSize(state.totalSizeBytes),
          })}
        </dd>
      )}
      {present && (
        <dd className="mt-3">
          <Button
            color="secondary-destructive"
            className="w-full justify-center"
            onPress={() => setConfirming(true)}
          >
            {m.agent_archive_delete_workspace()}
          </Button>
        </dd>
      )}
      <DeleteConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={m.computer_agent_workspace_delete_title({ name: agentName })}
        description={m.agent_archive_delete_workspace_description({ computer: computer.label })}
        confirmLabel={m.agent_archive_delete_workspace()}
        errorMessage={m.computer_agent_workspace_delete_error()}
        onConfirm={async () => {
          // As on the Computer page: done when removed, or when nothing was left to remove.
          const result = await remove({ data: { computerId: computer.id, agentId } });
          if (result.status !== "ok" && result.status !== "missing") throw new Error(result.status);
          setConfirming(false);
          await queryClient.invalidateQueries({ queryKey });
        }}
      />
    </>
  );
}

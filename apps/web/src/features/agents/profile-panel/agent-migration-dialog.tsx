import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";
import { useInvalidateAgentProfile } from "./agent-profile-queries";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { AlertCircle } from "@untitledui/icons";
import { Select } from "#src/components/base/select/select";
import { FeaturedIcon } from "#src/components/foundations/featured-icon/featured-icon";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";
import { localizeHref } from "#src/paraglide/runtime";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { workspacePath } from "#src/features/workspaces/workspace-url";
import {
  agentMigrationRefusal,
  type AgentMigrationFixAt,
} from "#src/features/agents/agent-migration";
import { runtimeProviderLabel } from "#src/features/agents/runtime-provider-display";
import {
  AgentMigrationRefusalNotice,
  notStartedAfterMove,
  useAgentMigrationNotStarted,
} from "./agent-migration-status";
import {
  listAgentMigrationTargets,
  requestAgentMigration,
} from "#src/features/agents/agent-migrations.functions";
type ComputerOption = { id: string; name: string };

function AgentMigrationForm({
  computers,
  selected,
  onSelect,
  disabled,
  direct,
}: {
  computers: readonly ComputerOption[];
  selected: string | null;
  onSelect: (computerId: string) => void;
  disabled?: boolean;
  direct?: boolean;
}) {
  const controlSize = useDialogControlSize();
  return (
    <div className="grid gap-4 px-6 pt-4">
      {computers.length === 0 ? (
        <p className="text-sm text-tertiary">{m.agent_migration_dialog_no_targets()}</p>
      ) : (
        <Select
          isRequired
          isDisabled={disabled}
          size={controlSize}
          label={m.agent_migration_dialog_target()}
          placeholder={m.agent_migration_dialog_target_placeholder()}
          selectedKey={selected}
          onSelectionChange={(key) => {
            if (key !== null) onSelect(String(key));
          }}
        >
          {computers.map((computer) => (
            <Select.Item
              key={computer.id}
              id={computer.id}
              label={computer.name || m.agent_computer_unnamed()}
            />
          ))}
        </Select>
      )}
      {!direct && (
        <div className="flex items-start gap-3">
          <FeaturedIcon color="warning" theme="light" size="sm" icon={AlertCircle} />
          <ul className="min-w-0 list-disc space-y-1 pl-5 text-sm text-secondary">
            <li>{m.agent_migration_dialog_session()}</li>
            <li>{m.agent_migration_dialog_stops()}</li>
            <li>{m.agent_migration_dialog_left_behind()}</li>
          </ul>
        </div>
      )}
    </div>
  );
}

export function AgentMigrationDialog({
  agentId,
  agentName,
  currentComputerId,
  runtime,
  model,
  direct,
  revoked,
  onClose,
}: {
  agentId: string;
  agentName: string;
  currentComputerId: string | null;
  runtime: RuntimeProvider;
  model: string;
  direct: boolean;
  revoked: boolean;
  onClose: () => void;
}) {
  const freshDirect = direct && !revoked;
  const queryClient = useQueryClient();
  const statusKey = ["agent-migration", agentId] as const;
  const workspaceSlug = useWorkspaceSlug();
  const invalidateProfile = useInvalidateAgentProfile(agentId);
  const requestMove = useServerFn(requestAgentMigration);
  const loadTargets = useServerFn(listAgentMigrationTargets);
  const [selected, setSelected] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{
    message: string;
    fixAt: AgentMigrationFixAt;
    targetComputerId: string;
  } | null>(null);
  const { setNotStarted: setNotStartedOn } = useAgentMigrationNotStarted(agentId);
  const [submitting, guardSubmit] = useSubmitGuard();
  const computers = useQuery({
    queryKey: ["agent-migration-targets", agentId, currentComputerId],
    queryFn: () => loadTargets({ data: { agentId } }),
  });
  const targets: ComputerOption[] = computers.data ?? [];

  const refresh = () =>
    Promise.all([queryClient.invalidateQueries({ queryKey: statusKey }), invalidateProfile()]);

  function submit() {
    if (!selected || submitting) return;
    const targetComputerId = selected;
    setRefusal(null);
    setNotStartedOn(null);
    void guardSubmit(async () => {
      try {
        const moved = await requestMove({ data: { agentId, targetComputerId } });
        onClose();
        setNotStartedOn(
          notStartedAfterMove(
            moved,
            targets.find(({ id }) => id === targetComputerId)?.name || m.agent_computer_unnamed(),
          ),
        );
        await refresh();
      } catch (cause) {
        setRefusal({
          ...agentMigrationRefusal(cause, {
            computer:
              targets.find(({ id }) => id === targetComputerId)?.name || m.agent_computer_unnamed(),
            runtime: runtimeProviderLabel(runtime),
            model,
          }),
          targetComputerId,
        });
        await refresh().catch(() => undefined);
      }
    });
  }

  function refusalLink(fixAt: AgentMigrationFixAt, targetComputerId: string) {
    if (!fixAt) return null;
    const computerId =
      fixAt === "source" ? currentComputerId : fixAt === "target" ? targetComputerId : null;
    return computerId
      ? {
          href: localizeHref(workspacePath(workspaceSlug, `/computer/${computerId}`)),
          label: m.agent_migration_open_computer(),
        }
      : {
          href: localizeHref(workspacePath(workspaceSlug, "/computers")),
          label: m.agent_migration_open_computers(),
        };
  }

  return (
    <ModalOverlay
      isOpen
      onOpenChange={(next: boolean) => {
        if (submitting) return;
        if (!next) onClose();
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-lg">
        <Dialog className="text-left">
          {({ close }) => (
            <>
              <DialogHeader
                title={
                  freshDirect
                    ? m.agent_migration_dialog_title_fresh()
                    : direct && revoked
                      ? m.agent_migration_dialog_title_change()
                      : m.agent_migration_dialog_title({ name: agentName })
                }
                onClose={submitting ? undefined : close}
              />
              <AgentMigrationForm
                computers={targets}
                selected={selected}
                onSelect={setSelected}
                disabled={submitting}
                direct={direct}
              />
              {refusal && (
                <AgentMigrationRefusalNotice
                  message={refusal.message}
                  link={refusalLink(refusal.fixAt, refusal.targetComputerId)}
                />
              )}
              <DialogActions className="mt-6 shrink-0 px-6 pb-6">
                <DialogCancel isDisabled={submitting} onPress={close}>
                  {m.controls_cancel()}
                </DialogCancel>
                <DialogAction
                  isDisabled={!selected || submitting}
                  isLoading={submitting}
                  showTextWhileLoading
                  onPress={submit}
                >
                  {submitting
                    ? m.agent_migration_submit_pending()
                    : refusal
                      ? m.agent_migration_try_again()
                      : freshDirect
                        ? m.agent_migration_submit_fresh()
                        : direct && revoked
                          ? m.agent_migration_submit_change()
                          : m.agent_migration_submit()}
                </DialogAction>
              </DialogActions>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

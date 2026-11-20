import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, SwitchHorizontal01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Select } from "#src/components/base/select/select";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { FeaturedIcon } from "#src/components/foundations/featured-icon/featured-icon";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";
import { localizeHref } from "#src/paraglide/runtime";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { workspacePath } from "#src/features/workspaces/workspace-url";
import {
  agentMigrationErrorMessage,
  agentMigrationRefusal,
  isAgentMigrationInProgress,
  isAgentMigrationShown,
  type AgentMigrationFixAt,
} from "#src/features/agents/agent-migration";
import { runtimeProviderLabel } from "#src/features/agents/runtime-provider-display";
import { useInvalidateAgentProfile } from "./agent-profile-queries";
import {
  AgentMigrationCancelBody,
  AgentMigrationNotStarted,
  AgentMigrationRefusalNotice,
  AgentMigrationStatus,
  notStartedAfterMove,
  useAgentMigrationNotStarted,
  useAgentMigrationStatus,
  writeAgentMigrationNotStarted,
} from "./agent-migration-status";
import {
  cancelAgentMigration,
  listAgentMigrationTargets,
  requestAgentMigration,
} from "#src/features/agents/agent-migrations.functions";

type ComputerOption = { id: string; name: string };

/** The move dialog's body: the target Computer, then what moves and what stays. */
export function AgentMigrationForm({
  computers,
  selected,
  onSelect,
  disabled,
  direct,
}: {
  /** The Workspace's other Computers; whether one can take the Agent is checked on Move. */
  computers: readonly ComputerOption[];
  selected: string | null;
  onSelect: (computerId: string) => void;
  disabled?: boolean;
  direct?: { sourceName: string | null };
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
      {direct?.sourceName && (
        <div className="flex items-start gap-3">
          <FeaturedIcon color="warning" theme="light" size="sm" icon={AlertCircle} />
          <p className="min-w-0 pt-1 text-sm text-secondary">
            {m.agent_migration_direct_left_behind({ computer: direct.sourceName })}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * The Profile's "Move to another Computer": the Agent's latest move, read again while it is
 * going, and for its owner the action that starts one and the cancel that ends it. The whole
 * section is absent while this server cannot move Agents and there is no move to show.
 */
export function AgentMigrationSection({
  agentId,
  agentName,
  currentComputerId,
  canMove,
  runtime,
  model,
  agentOnline,
}: {
  agentId: string;
  agentName: string;
  currentComputerId: string | null;
  /** Whoever manages the Agent moves it: its owner or a Workspace owner/admin (`AgentMigrationRequests`). */
  canMove: boolean;
  /** The Agent's runtime and model, which a refusal of the target names. */
  runtime: RuntimeProvider;
  model: string;
  agentOnline: boolean;
}) {
  const queryClient = useQueryClient();
  const workspaceSlug = useWorkspaceSlug();
  const invalidateProfile = useInvalidateAgentProfile(agentId);
  const requestMove = useServerFn(requestAgentMigration);
  const cancelMove = useServerFn(cancelAgentMigration);
  const loadTargets = useServerFn(listAgentMigrationTargets);
  const [open, setOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{
    message: string;
    fixAt: AgentMigrationFixAt;
    targetComputerId: string;
  } | null>(null);
  const [cancelError, setCancelError] = useState("");
  const { notStarted: notStartedOn, setNotStarted: setNotStartedOn } =
    useAgentMigrationNotStarted(agentId);
  const [submitting, guardSubmit] = useSubmitGuard();
  const [canceling, guardCancel] = useSubmitGuard();

  useEffect(() => {
    if (agentOnline && notStartedOn) writeAgentMigrationNotStarted(queryClient, agentId, null);
  }, [agentOnline, notStartedOn, queryClient, agentId]);

  const statusKey = ["agent-migration", agentId] as const;
  const status = useAgentMigrationStatus(agentId);
  const computers = useQuery({
    queryKey: ["agent-migration-targets", agentId, currentComputerId],
    queryFn: () => loadTargets({ data: { agentId } }),
    enabled: open,
  });
  const targets: ComputerOption[] = computers.data ?? [];

  const latest = status.data?.migration;
  const migration = latest && isAgentMigrationShown(latest) ? latest : undefined;
  const inProgress = migration ? isAgentMigrationInProgress(migration.state) : false;

  // A move that just finished changed the Agent's Computer: the profile shows the new one.
  const wasInProgress = useRef(inProgress);
  useEffect(() => {
    if (wasInProgress.current && !inProgress) void invalidateProfile();
    wasInProgress.current = inProgress;
  }, [inProgress, invalidateProfile]);

  if (!status.data || (!status.data.available && !migration)) {
    return notStartedOn && !agentOnline ? (
      <AgentMigrationNotStarted
        computerName={notStartedOn.computerName}
        assigned={notStartedOn.assigned}
      />
    ) : null;
  }
  const direct = status.data.directPlacement === true;
  const revoked = status.data.computerAccessRevoked === true;
  const sourceName = status.data.sourceComputerName || null;
  const freshDirect = direct && !revoked;

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
        setOpen(false);
        setNotStartedOn(
          notStartedAfterMove(
            moved,
            targets.find(({ id }) => id === targetComputerId)?.name || m.agent_computer_unnamed(),
          ),
        );
        await refresh();
      } catch (cause) {
        // The dialog stays open: it says why, links to where to fix it, and offers to try again.
        setRefusal({
          ...agentMigrationRefusal(cause, {
            computer:
              targets.find(({ id }) => id === targetComputerId)?.name || m.agent_computer_unnamed(),
            runtime: runtimeProviderLabel(runtime),
            model,
          }),
          targetComputerId,
        });
        // A Stop can succeed and the response still fail. Refresh so an active move
        // shows its progress and Cancel instead of the stale idle status.
        await refresh().catch(() => undefined);
      }
    });
  }

  /** The page that can fix a refusal: the Computer it names, or else the Computers page. */
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

  function cancel() {
    if (!migration || canceling) return;
    setCancelError("");
    void guardCancel(async () => {
      try {
        await cancelMove({ data: { agentId, migrationId: migration.id } });
        setConfirmCancel(false);
        await refresh();
      } catch (cause) {
        setCancelError(agentMigrationErrorMessage(cause));
        await refresh().catch(() => undefined);
      }
    });
  }

  return (
    <>
      {direct && !inProgress && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-secondary bg-secondary px-3 py-2.5">
          <FeaturedIcon color="warning" theme="light" size="sm" icon={AlertCircle} />
          <p className="min-w-0 flex-1 basis-52 text-sm text-secondary">
            {revoked
              ? m.agent_migration_revoked_title({
                  computer: sourceName || m.agent_computer_unnamed(),
                })
              : m.agent_migration_no_computer_title()}
          </p>
          {canMove && status.data.available && (
            <Button
              color="secondary"
              size="sm"
              iconLeading={SwitchHorizontal01}
              onPress={() => {
                setSelected(null);
                setRefusal(null);
                setOpen(true);
              }}
            >
              {migration?.state === "failed" || migration?.state === "canceled"
                ? m.agent_migration_retry()
                : revoked
                  ? m.agent_migration_action_change()
                  : m.agent_migration_action_fresh()}
            </Button>
          )}
        </div>
      )}
      {notStartedOn && !agentOnline && (
        <AgentMigrationNotStarted
          computerName={notStartedOn.computerName}
          assigned={notStartedOn.assigned}
        />
      )}
      {migration && (
        <AgentMigrationStatus
          migration={migration}
          targetName={migration.targetComputerName || m.agent_computer_unnamed()}
          sourceName={migration.sourceComputerName || m.agent_computer_unnamed()}
          onCancel={
            canMove
              ? () => {
                  setCancelError("");
                  setConfirmCancel(true);
                }
              : undefined
          }
          canceling={canceling}
        />
      )}
      {!direct && canMove && status.data.available && !inProgress && (
        <Button
          color="secondary"
          className="w-full justify-center"
          iconLeading={SwitchHorizontal01}
          onPress={() => {
            setSelected(null);
            setRefusal(null);
            setOpen(true);
          }}
        >
          {migration?.state === "failed" || migration?.state === "canceled"
            ? m.agent_migration_retry()
            : m.agent_migration_action()}
        </Button>
      )}
      <ModalOverlay
        confirmation
        isOpen={confirmCancel}
        onOpenChange={(next: boolean) => {
          if (canceling) return;
          setConfirmCancel(next);
        }}
      >
        <Modal className="w-[calc(100vw-2rem)] max-w-md">
          <Dialog className="text-left">
            {({ close }) => (
              <>
                <DialogHeader
                  title={m.agent_migration_cancel_title()}
                  onClose={canceling ? undefined : close}
                />
                <AgentMigrationCancelBody switched={migration?.state === "switched"} />
                {cancelError && (
                  <p role="alert" className="px-6 pt-4 text-sm text-error-primary">
                    {cancelError}
                  </p>
                )}
                <DialogActions className="mt-6 shrink-0 px-6 pb-6">
                  <DialogCancel isDisabled={canceling} onPress={close}>
                    {m.agent_migration_cancel_keep()}
                  </DialogCancel>
                  <DialogAction
                    autoFocus
                    isDisabled={canceling}
                    isLoading={canceling}
                    showTextWhileLoading
                    onPress={cancel}
                  >
                    {m.agent_migration_cancel_confirm()}
                  </DialogAction>
                </DialogActions>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
      <ModalOverlay
        isOpen={open}
        onOpenChange={(next: boolean) => {
          if (submitting) return;
          setOpen(next);
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
                  direct={
                    direct
                      ? {
                          sourceName: revoked ? (sourceName ?? m.agent_computer_unnamed()) : null,
                        }
                      : undefined
                  }
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
    </>
  );
}

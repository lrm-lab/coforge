import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, SwitchHorizontal01 } from "@untitledui/icons";
import { Radio, RadioGroup } from "react-aria-components";

import { CircleAlert, Laptop } from "kubai-icons/duotone";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { Skeleton } from "#src/components/ui/skeleton";
import { Button } from "#src/components/base/buttons/button";
import { Label } from "#src/components/base/input/label";
import { Select } from "#src/components/base/select/select";
import { Dialog, Modal, ModalOverlay, useConfirmationSheet } from "#src/components/ui/modal";
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
import { cx } from "#src/utils/cx";
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
  ComputerStatusIcon,
  computerOptionClassName,
} from "#src/features/computers/computer-status-icon";
import {
  cancelAgentMigration,
  listAgentMigrationTargets,
  requestAgentMigration,
} from "#src/features/agents/agent-migrations.functions";

type ComputerOption = {
  id: string;
  name: string;
  displayName: string;
  kind: string;
  online: boolean;
};

function targetComputerLabel(computer: ComputerOption) {
  return computer.displayName.trim() || computer.name.trim() || m.agent_computer_unnamed();
}

function targetComputerAriaLabel(computer: ComputerOption, label: string) {
  return `${label}, ${computer.online ? m.computer_status_online() : m.computer_status_offline()}`;
}

export function AgentMigrationForm({
  computers,
  selected,
  onSelect,
  disabled,
  direct,
  loading = false,
  failed = false,
  retrying = false,
  onRetry,
  connectHref,
}: {
  computers: readonly ComputerOption[];
  selected: string | null;
  onSelect: (computerId: string) => void;
  disabled?: boolean;
  direct?: boolean;
  loading?: boolean;
  failed?: boolean;
  retrying?: boolean;
  onRetry?: () => void;
  connectHref?: string;
}) {
  const controlSize = useDialogControlSize();
  const isSheet = useConfirmationSheet();
  return (
    <div className="grid gap-4 px-6 pt-4 max-sm:px-4">
      {loading ? (
        <div role="status" aria-label={m.empty_agent_migration_loading()} className="grid gap-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : failed ? (
        <EmptyState
          size="card"
          role="alert"
          picture={<EmptyIcon icon={CircleAlert} size="card" />}
          title={m.empty_agent_migration_load_failed()}
          primaryAction={
            onRetry ? (
              <RetryButton size="card" isRetrying={retrying} onPress={onRetry} />
            ) : undefined
          }
        />
      ) : computers.length === 0 ? (
        <EmptyState
          size="card"
          picture={<EmptyIcon icon={Laptop} size="card" />}
          title={m.empty_agent_migration_none()}
          primaryAction={
            connectHref ? (
              <Button size="sm" color="tertiary" href={connectHref}>
                {m.empty_agent_migration_connect()}
              </Button>
            ) : undefined
          }
        />
      ) : isSheet ? (
        <RadioGroup
          isRequired
          isDisabled={disabled}
          value={selected ?? ""}
          onChange={onSelect}
          className="flex min-w-0 flex-col gap-1.5"
        >
          <Label isRequired>{m.agent_migration_dialog_target()}</Label>
          <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto rounded-xl border border-secondary bg-primary p-1">
            {computers.map((computer) => {
              const label = targetComputerLabel(computer);
              return (
                <Radio
                  key={computer.id}
                  value={computer.id}
                  aria-label={targetComputerAriaLabel(computer, label)}
                  className={({ isSelected, isFocusVisible, isDisabled }) =>
                    cx(
                      "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-md outline-hidden select-none",
                      isSelected && "bg-primary_hover",
                      isFocusVisible && "ring-2 ring-focus-ring ring-inset",
                      isDisabled && "cursor-not-allowed opacity-50",
                    )
                  }
                >
                  {({ isSelected }) => (
                    <>
                      <ComputerStatusIcon
                        computer={computer}
                        online={computer.online}
                        className="size-5"
                      />
                      <span
                        className={cx(
                          "min-w-0 flex-1 truncate font-medium",
                          computer.online ? "text-primary" : "text-quaternary",
                        )}
                      >
                        {label}
                      </span>
                      {isSelected && (
                        <Check
                          aria-hidden="true"
                          className="ml-auto size-5 shrink-0 text-fg-brand-primary"
                        />
                      )}
                    </>
                  )}
                </Radio>
              );
            })}
          </div>
        </RadioGroup>
      ) : (
        <Select
          isRequired
          isDisabled={disabled}
          size={controlSize}
          label={m.agent_migration_dialog_target()}
          placeholder={m.agent_migration_dialog_target_placeholder()}
          className="min-w-0"
          selectedKey={selected}
          onSelectionChange={(key) => {
            if (key !== null) onSelect(String(key));
          }}
        >
          {computers.map((computer) => {
            const label = targetComputerLabel(computer);
            return (
              <Select.Item
                key={computer.id}
                id={computer.id}
                label={label}
                aria-label={targetComputerAriaLabel(computer, label)}
                icon={<ComputerStatusIcon computer={computer} online={computer.online} />}
                className={computerOptionClassName(computer.online)}
              />
            );
          })}
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
    staleTime: 0,
  });
  const targets: ComputerOption[] = computers.data ?? [];

  const latest = status.data?.migration;
  const migration = latest && isAgentMigrationShown(latest) ? latest : undefined;
  const inProgress = migration ? isAgentMigrationInProgress(migration.state) : false;

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
  const freshDirect = direct && !revoked;

  const refresh = () =>
    Promise.all([queryClient.invalidateQueries({ queryKey: statusKey }), invalidateProfile()]);

  function submit() {
    if (!selected || submitting) return;
    const targetComputerId = selected;
    const target = targets.find(({ id }) => id === targetComputerId);
    const targetName = target ? targetComputerLabel(target) : m.agent_computer_unnamed();
    setRefusal(null);
    setNotStartedOn(null);
    void guardSubmit(async () => {
      try {
        const moved = await requestMove({ data: { agentId, targetComputerId } });
        setOpen(false);
        setNotStartedOn(notStartedAfterMove(moved, targetName));
        await refresh();
      } catch (cause) {
        setRefusal({
          ...agentMigrationRefusal(cause, {
            computer: targetName,
            runtime: runtimeProviderLabel(runtime),
            model,
          }),
          targetComputerId,
        });
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
      {canMove && status.data.available && !inProgress && (
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
            : revoked
              ? m.agent_migration_action_change()
              : freshDirect
                ? m.agent_migration_action_fresh()
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
        confirmation
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
                  direct={direct}
                  loading={computers.isPending}
                  failed={computers.isError && computers.data === undefined}
                  retrying={computers.isRefetching}
                  onRetry={() => {
                    void computers.refetch();
                  }}
                  connectHref={localizeHref(workspacePath(workspaceSlug, "/computers?add=1"))}
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

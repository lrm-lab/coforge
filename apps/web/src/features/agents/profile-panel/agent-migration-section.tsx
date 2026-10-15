import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, SwitchHorizontal01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Select } from "#src/components/base/select/select";
import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
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
  agentMigrationStatusLine,
  agentMigrationSteps,
  isAgentMigrationInProgress,
  isAgentMigrationShown,
  type AgentMigrationFixAt,
} from "#src/features/agents/agent-migration";
import { useInvalidateAgentProfile } from "./agent-profile-queries";
import {
  cancelAgentMigration,
  getAgentMigration,
  listAgentMigrationTargets,
  requestAgentMigration,
} from "#src/features/agents/agent-migrations.functions";

type ComputerOption = { id: string; name: string };

/** How often a move in progress is read again; each stage takes seconds to minutes. */
const PROGRESS_POLL_MS = 3_000;

/** One line on where the Agent's latest move stands, with a cancel while it is going. */
export function AgentMigrationStatus({
  migration,
  targetName,
  sourceName,
  onCancel,
  canceling,
}: {
  migration: { state: string; errorCode: string | null };
  targetName: string;
  sourceName: string;
  onCancel?: () => void;
  canceling?: boolean;
}) {
  const inProgress = isAgentMigrationInProgress(migration.state);
  return (
    <div className="grid gap-2 rounded-lg border border-secondary px-3 py-2.5">
      <p
        role="status"
        className={
          migration.state === "failed" ? "text-sm text-error-primary" : "text-sm text-secondary"
        }
      >
        {agentMigrationStatusLine(migration, targetName, sourceName)}
      </p>
      {(inProgress || migration.state === "completed") && (
        <ol className="grid gap-1 text-sm">
          {agentMigrationSteps(migration.state).map((step) => (
            <li
              key={step.label}
              className={
                step.status === "pending"
                  ? "flex items-center gap-2 text-quaternary"
                  : "flex items-center gap-2 text-secondary"
              }
            >
              <span
                aria-hidden="true"
                className={
                  step.status === "done"
                    ? "size-2 rounded-full bg-success-solid"
                    : step.status === "current"
                      ? "size-2 rounded-full bg-fg-secondary motion-safe:animate-pulse"
                      : "size-2 rounded-full bg-quaternary"
                }
              />
              <span>{step.label}</span>
              <span className="sr-only">
                {step.status === "done"
                  ? m.agent_migration_step_done()
                  : step.status === "current"
                    ? m.agent_migration_step_current()
                    : m.agent_migration_step_pending()}
              </span>
            </li>
          ))}
        </ol>
      )}
      {inProgress && onCancel && (
        <Button
          color="secondary"
          size="sm"
          className="justify-self-start"
          isDisabled={canceling}
          isLoading={canceling}
          onPress={onCancel}
        >
          {m.agent_migration_cancel()}
        </Button>
      )}
    </div>
  );
}

/** What canceling does, which depends on whether the Agent has already switched Computers. */
export function AgentMigrationCancelBody({ switched }: { switched: boolean }) {
  return (
    <p className="px-6 pt-4 text-sm text-secondary">
      {switched
        ? m.agent_migration_cancel_after_switch()
        : m.agent_migration_cancel_before_switch()}
    </p>
  );
}

/** The move dialog's body: the target Computer, then what moves and what stays. */
export function AgentMigrationForm({
  computers,
  selected,
  onSelect,
  disabled,
}: {
  /** The Workspace's other Computers; whether one can take the Agent is checked on Move. */
  computers: readonly ComputerOption[];
  selected: string | null;
  onSelect: (computerId: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-4 px-6 pt-4">
      {computers.length === 0 ? (
        <p className="text-sm text-tertiary">{m.agent_migration_dialog_no_targets()}</p>
      ) : (
        <Select
          isRequired
          isDisabled={disabled}
          size="md"
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
      <div className="flex items-start gap-3">
        <FeaturedIcon color="warning" theme="light" size="sm" icon={AlertCircle} />
        <ul className="min-w-0 list-disc space-y-1 pl-5 text-sm text-secondary">
          <li>{m.agent_migration_dialog_session()}</li>
          <li>{m.agent_migration_dialog_stops()}</li>
          <li>{m.agent_migration_dialog_left_behind()}</li>
        </ul>
      </div>
    </div>
  );
}

/** Why the move was refused, with a link to the page where it can be fixed. */
export function AgentMigrationRefusalNotice({
  message,
  link,
}: {
  message: string;
  link: { href: string; label: string } | null;
}) {
  return (
    <div
      role="alert"
      className="mx-6 mt-4 flex items-start gap-3 rounded-lg border border-secondary bg-warning-primary px-3 py-2.5"
    >
      <FeaturedIcon color="warning" theme="light" size="sm" icon={AlertCircle} />
      <div className="grid min-w-0 gap-1 text-sm">
        <p className="text-secondary">{message}</p>
        {link && (
          <a
            href={link.href}
            className="justify-self-start font-semibold text-brand-secondary hover:underline"
          >
            {link.label}
          </a>
        )}
      </div>
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
  isOwner,
}: {
  agentId: string;
  agentName: string;
  currentComputerId: string | null;
  /** Only the Agent's owner moves it (`AgentMigrationRequests`). */
  isOwner: boolean;
}) {
  const queryClient = useQueryClient();
  const workspaceSlug = useWorkspaceSlug();
  const invalidateProfile = useInvalidateAgentProfile(agentId);
  const readMigration = useServerFn(getAgentMigration);
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
  const [submitting, guardSubmit] = useSubmitGuard();
  const [canceling, guardCancel] = useSubmitGuard();

  const statusKey = ["agent-migration", agentId] as const;
  const status = useQuery({
    queryKey: statusKey,
    queryFn: () => readMigration({ data: { agentId } }),
    refetchInterval: (query) =>
      query.state.data?.migration && isAgentMigrationInProgress(query.state.data.migration.state)
        ? PROGRESS_POLL_MS
        : false,
  });
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

  if (!status.data || (!status.data.available && !migration)) return null;

  const refresh = () =>
    Promise.all([queryClient.invalidateQueries({ queryKey: statusKey }), invalidateProfile()]);

  function submit() {
    if (!selected || submitting) return;
    const targetComputerId = selected;
    setRefusal(null);
    void guardSubmit(async () => {
      try {
        await requestMove({ data: { agentId, targetComputerId } });
        setOpen(false);
        await refresh();
      } catch (cause) {
        // The dialog stays open: it says why, links to where to fix it, and offers to try again.
        setRefusal({ ...agentMigrationRefusal(cause), targetComputerId });
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
      {migration && (
        <AgentMigrationStatus
          migration={migration}
          targetName={migration.targetComputerName || m.agent_computer_unnamed()}
          sourceName={migration.sourceComputerName || m.agent_computer_unnamed()}
          onCancel={
            isOwner
              ? () => {
                  setCancelError("");
                  setConfirmCancel(true);
                }
              : undefined
          }
          canceling={canceling}
        />
      )}
      {isOwner && status.data.available && !inProgress && (
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
        isOpen={confirmCancel}
        onOpenChange={(next: boolean) => {
          if (canceling) return;
          setConfirmCancel(next);
        }}
      >
        <Modal className="w-[calc(100vw-2rem)] max-w-md">
          <Dialog className="overflow-hidden text-left">
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
                <div className="mt-6 flex shrink-0 flex-wrap justify-end gap-3 border-t border-secondary px-6 py-4">
                  <Button color="secondary" isDisabled={canceling} onPress={close}>
                    {m.agent_migration_cancel_keep()}
                  </Button>
                  <Button
                    color="primary"
                    isDisabled={canceling}
                    isLoading={canceling}
                    showTextWhileLoading
                    onPress={cancel}
                  >
                    {m.agent_migration_cancel_confirm()}
                  </Button>
                </div>
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
          <Dialog className="overflow-hidden text-left">
            {({ close }) => (
              <>
                <DialogHeader
                  title={m.agent_migration_dialog_title({ name: agentName })}
                  onClose={submitting ? undefined : close}
                />
                <AgentMigrationForm
                  computers={targets}
                  selected={selected}
                  onSelect={setSelected}
                  disabled={submitting}
                />
                {refusal && (
                  <AgentMigrationRefusalNotice
                    message={refusal.message}
                    link={refusalLink(refusal.fixAt, refusal.targetComputerId)}
                  />
                )}
                <div className="mt-6 flex shrink-0 flex-wrap justify-end gap-3 border-t border-secondary px-6 py-4">
                  <Button color="secondary" isDisabled={submitting} onPress={close}>
                    {m.controls_cancel()}
                  </Button>
                  <Button
                    color="primary"
                    isDisabled={!selected || submitting}
                    isLoading={submitting}
                    showTextWhileLoading
                    onPress={submit}
                  >
                    {submitting
                      ? m.agent_migration_submit_pending()
                      : refusal
                        ? m.agent_migration_try_again()
                        : m.agent_migration_submit()}
                  </Button>
                </div>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </>
  );
}

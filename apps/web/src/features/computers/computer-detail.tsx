import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle,
  Check,
  Copy01 as Copy,
  Edit01 as Pencil,
  Plus,
  SearchLg as Scan,
  RefreshCw01 as RotateCw,
  Terminal,
  Trash01 as Trash,
  XClose as X,
} from "@untitledui/icons";
import { useHydrated } from "@tanstack/react-router";
import { Heading, Text } from "react-aria-components";
import type { RuntimeProvider, AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { Avatar } from "#src/components/base/avatar/avatar";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { Checkbox as AriaCheckbox } from "react-aria-components";
import { CheckboxBase } from "#src/components/base/checkbox/checkbox";
import { Toggle } from "#src/components/base/toggle/toggle";
import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { FeaturedIcon } from "#src/components/foundations/featured-icon/featured-icon";
import { StatusDot } from "#src/components/ui/status-dot";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { formatCalendarDate } from "#src/lib/dates";
import { cn } from "#src/lib/utils";
import { getLocale } from "#src/paraglide/runtime";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { useAppToast } from "#src/components/ui/toast";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { humanLabel } from "#src/lib/human-label";
import { m } from "#src/paraglide/messages";
import { BackToComputers } from "./back-to-computers";
import { useUpgradingComputer } from "./computer-layout";
import {
  computerLabel,
  computerVersionLabel,
  isComputerUpdateAvailable,
  operatingSystemLabel,
  type ComputerIdentity,
} from "./computer-identity";
import {
  ComputerUpgradeFailureView,
  describeComputerUpgradeFailure,
  describeComputerUpgradeSuccess,
  describeUpgradeRequestError,
  type UpgradeFailureView,
} from "./upgrade-failure";
import { ComputerTile } from "./computer-tile";
import {
  RuntimeIdentity,
  RuntimeUsage,
  UsageHealthDot,
  type Runtime,
  type UsageHealth,
} from "./runtime-usage";
import { RuntimeProviderMark } from "#src/features/agents/runtime-provider-mark";
import { runtimeProviderLabel } from "#src/features/agents/runtime-provider-display";
import { AgentCreateDialog } from "#src/features/agents/agent-create-dialog";
import type { CreateAgentInput } from "#src/features/agents/agent.schemas";
import type { RuntimeCatalog } from "#src/features/agents/agent-runtime-fields";
import { AgentDisplayAvatar } from "#src/features/agents/agent-display-avatar";
import { useLiveAgentDisplay } from "#src/features/agents/workspace-agents-realtime";
import { AgentControlDialogs } from "#src/features/agents/agent-control-dialogs";
import {
  useAgentRuntimeControls,
  type AgentControlExecute,
} from "#src/features/agents/agent-runtime-controls";
import type {
  ComputerAgentWorkspaceScan,
  ComputerRestartStatus,
  ComputerUpgradeStatus,
} from "./computer.schemas";

export const RESTART_POLL_INTERVAL_MS = 2_000;
export const RESTART_MAX_POLLS = 31;

/**
 * An upgrade is an external one-shot job, not an in-process restart, and it takes far longer than
 * one: on a real machine `upgrade-results/<id>.request.json` -> `.result.json` took about two
 * minutes. The restart window above is sized for a restart, and reusing it here made a perfectly
 * healthy upgrade look like a failure - the panel gave up while the job was still running, the
 * Upgrade button came back, and the second click was refused with `UPGRADE_OPERATION_PENDING` and
 * rendered as a failure. Three minutes covers the observed job with margin.
 */
export const UPGRADE_POLL_INTERVAL_MS = 3_000;
export const UPGRADE_MAX_POLLS = 60;

export type ComputerDetailView = ComputerIdentity & {
  id: string;
  ownedByCurrentUser: boolean;
  canManageAgents: boolean;
  online: boolean;
  connectedAt: Date | string;
  computerVersion?: string | null;
  platform?: string | null;
  osVersion?: string | null;
  creator?: {
    displayName: string | null;
    username: string;
    avatarUrl: string | null;
  };
  runtimes: {
    id: string;
    provider: RuntimeProvider;
    version: string;
    displayName: string;
    isPublic: boolean;
  }[];
  agents: {
    id: string;
    name: string;
    displayName: string;
    avatarUrl: string | null;
    provider: RuntimeProvider;
    runtimeConfig: { model?: string; modelProvider?: string };
    display?: AgentDisplaySnapshot;
  }[];
};

/** One failure-recovery command, in the app's mono command style, with a copy-to-clipboard
 * affordance - the same `ButtonUtility` + Copy/Check pattern `ComputerInstallCommand` already
 * uses, sized for an inline list item rather than a terminal block. */
function UpgradeCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-secondary px-1.5 py-0.5 align-middle font-mono text-xs text-secondary">
      {command}
      <ButtonUtility
        icon={copied ? Check : Copy}
        size="xs"
        color="tertiary"
        aria-label={m.computer_copy_command()}
        onClick={() => {
          void navigator.clipboard.writeText(command);
          setCopied(true);
        }}
      />
    </span>
  );
}

/**
 * One Computer's detail panel: what this machine is, which Code Agents it
 * carries, and the usage scan each of them answers.
 */
export function ComputerDetail({
  computer,
  timeZone = null,
  onSetRuntimePublic,
  onUpdateDisplayName,
  onRestart,
  onReadRestartStatus,
  onUpgrade,
  onReadUpgradeStatus,
  latestComputerVersion,
  restartPollIntervalMs = RESTART_POLL_INTERVAL_MS,
  restartMaxPolls = RESTART_MAX_POLLS,
  upgradePollIntervalMs = UPGRADE_POLL_INTERVAL_MS,
  upgradeMaxPolls = UPGRADE_MAX_POLLS,
  onScanAgentWorkspaces,
  onDeleteAgentWorkspace,
  onDeleteComputer,
  onCreateAgent,
  onLoadRuntimeCatalog,
  onSelectAgent,
  onExecuteAgentControl,
}: {
  computer: ComputerDetailView;
  timeZone?: string | null;
  onSetRuntimePublic: (runtimeId: string, isPublic: boolean) => Promise<void>;
  onUpdateDisplayName?: (displayName: string) => Promise<void>;
  onRestart?: (requestId: string) => Promise<ComputerRestartStatus>;
  onReadRestartStatus?: (requestId: string) => Promise<ComputerRestartStatus>;
  onUpgrade?: (requestId: string) => Promise<ComputerUpgradeStatus>;
  onReadUpgradeStatus?: (requestId: string) => Promise<ComputerUpgradeStatus>;
  onScanAgentWorkspaces?: () => Promise<ComputerAgentWorkspaceScan[]>;
  onDeleteAgentWorkspace?: (agentId: string) => Promise<{ status: string }>;
  onDeleteComputer?: () => Promise<void>;
  onCreateAgent?: (input: CreateAgentInput) => Promise<{ startPublished: boolean }>;
  onLoadRuntimeCatalog?: (computerId: string) => Promise<RuntimeCatalog[]>;
  onSelectAgent?: (agentId: string) => void;
  onExecuteAgentControl?: AgentControlExecute;
  latestComputerVersion?: string | null;
  restartPollIntervalMs?: number;
  restartMaxPolls?: number;
  upgradePollIntervalMs?: number;
  upgradeMaxPolls?: number;
}) {
  const [updatingRuntimeIdsState, setUpdatingRuntimeIdsState] = useState(() => new Set<string>());
  const updatingRuntimeIds = useRef(new Set<string>());
  const [runtimeVisibilityErrorIds, setRuntimeVisibilityErrorIds] = useState(
    () => new Set<string>(),
  );
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState(computer.displayName);
  const [savingDisplayName, setSavingDisplayName] = useState(false);
  const [displayNameError, setDisplayNameError] = useState(false);
  const [workspaceScan, setWorkspaceScan] = useState<
    | { state: "idle" }
    | { state: "scanning" }
    | { state: "ready"; workspaces: ComputerAgentWorkspaceScan[] }
    | { state: "error" }
  >({ state: "idle" });
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const workspaceSlug = useWorkspaceSlug();
  const toast = useAppToast();
  const creatorName = computer.creator ? humanLabel(computer.creator) : "";
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );
  const [restartState, setRestartState] = useState<
    "idle" | "pending" | "accepted" | "completed" | "error"
  >("idle");
  const { upgradingComputerIds, setUpgradingComputer } = useUpgradingComputer();
  const [upgrade, setUpgrade] = useState<
    | { state: "idle" }
    | { state: "running" }
    | ({ state: "failed"; errorId?: string } & UpgradeFailureView)
  >({ state: "idle" });
  const upgrading = upgrade.state === "running" || upgradingComputerIds.has(computer.id);
  const upgradeAvailable =
    onUpgrade &&
    computer.ownedByCurrentUser &&
    isComputerUpdateAvailable(computer.computerVersion, latestComputerVersion);
  const canEditDisplayName = computer.ownedByCurrentUser && Boolean(onUpdateDisplayName);
  const runUpgrade = async () => {
    if (!onUpgrade) return;
    const requestId = crypto.randomUUID();
    setUpgrade({ state: "running" });
    setUpgradingComputer(computer.id, true);
    const settle = (update: () => void) => {
      if (mountedRef.current) update();
    };
    try {
      const accepted = await onUpgrade(requestId);
      if (accepted.status !== "accepted")
        throw new ComputerUpgradeFailureView(
          describeComputerUpgradeFailure({ reason: "publication" }),
        );
      if (!onReadUpgradeStatus) return;
      for (let poll = 0; poll < upgradeMaxPolls; poll += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, upgradePollIntervalMs));
        const status = await onReadUpgradeStatus(requestId);
        if (status.status === "completed" && status.computerVersion) {
          // The version itself moves to the Version row (the caller invalidates the loader); the
          // toast is only the one-line confirmation that the action just taken succeeded.
          settle(() => {
            toast.success(describeComputerUpgradeSuccess(status.computerVersion));
            setUpgrade({ state: "idle" });
          });
          return;
        }
        if (status.status === "completed")
          throw new ComputerUpgradeFailureView(
            describeComputerUpgradeFailure({ reason: "evidence" }),
          );
        if (status.status === "failed")
          throw new ComputerUpgradeFailureView(describeComputerUpgradeFailure(status));
        if (status.status === "unknown")
          throw new ComputerUpgradeFailureView(
            describeComputerUpgradeFailure({ reason: "evidence" }),
          );
      }
      throw new ComputerUpgradeFailureView(describeComputerUpgradeFailure({ reason: "timeout" }));
    } catch (error) {
      settle(() => {
        const copy = describeUpgradeRequestError(error);
        setUpgrade({
          state: "failed",
          headline: copy.headline,
          steps: copy.steps,
          errorId: copy.errorId,
        });
      });
    } finally {
      // The shared indicator clears whether or not this panel is still mounted: navigating to
      // another Computer unmounts this one, and a stale "upgrading" badge must not outlive the
      // operation it describes.
      setUpgradingComputer(computer.id, false);
    }
  };
  const setRuntimePublic = async (runtimeId: string, isPublic: boolean) => {
    if (updatingRuntimeIds.current.has(runtimeId)) return;
    updatingRuntimeIds.current.add(runtimeId);
    setUpdatingRuntimeIdsState((current) => new Set(current).add(runtimeId));
    setRuntimeVisibilityErrorIds((current) => {
      const next = new Set(current);
      next.delete(runtimeId);
      return next;
    });
    try {
      await onSetRuntimePublic(runtimeId, isPublic);
    } catch {
      setRuntimeVisibilityErrorIds((current) => new Set(current).add(runtimeId));
    } finally {
      updatingRuntimeIds.current.delete(runtimeId);
      setUpdatingRuntimeIdsState((current) => {
        const next = new Set(current);
        next.delete(runtimeId);
        return next;
      });
    }
  };

  const scanWorkspaces = async () => {
    if (!onScanAgentWorkspaces) return;
    setWorkspaceScan({ state: "scanning" });
    try {
      setWorkspaceScan({ state: "ready", workspaces: await onScanAgentWorkspaces() });
    } catch {
      setWorkspaceScan({ state: "error" });
    }
  };

  const upgradeButton =
    upgradeAvailable && latestComputerVersion ? (
      <Button
        type="button"
        size="sm"
        color="secondary"
        isLoading={upgrading}
        showTextWhileLoading
        isDisabled={upgrading}
        onPress={() => void runUpgrade()}
      >
        {upgrading
          ? m.computer_upgrade_in_progress()
          : m.computer_upgrade_action({ version: shortReleaseVersion(latestComputerVersion) })}
      </Button>
    ) : undefined;

  const runRestart = () => {
    if (!onRestart) return;
    setRestartState("pending");
    const requestId = crypto.randomUUID();
    // The restart poll outlives navigation; only touch state while still mounted.
    const settle = (update: () => void) => {
      if (mountedRef.current) update();
    };
    void onRestart(requestId)
      .then(async (initial) => {
        if (initial.status !== "accepted") return initial;
        settle(() => {
          setRestartState("accepted");
          toast.success(m.computer_restart_accepted());
        });
        if (!onReadRestartStatus) return initial;
        for (let poll = 0; poll < restartMaxPolls; poll += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, restartPollIntervalMs));
          const result = await onReadRestartStatus(requestId);
          if (result.status !== "accepted") return result;
        }
        return { requestId, status: "failed" as const, reason: "timeout" as const };
      })
      .then(
        (result) =>
          settle(() => {
            if (result.status === "completed") {
              setRestartState("completed");
              toast.success(m.computer_restart_completed());
            } else if (result.status === "accepted") {
              setRestartState("accepted");
            } else {
              setRestartState("error");
              toast.error(m.computer_restart_error());
            }
          }),
        () =>
          settle(() => {
            setRestartState("error");
            toast.error(m.computer_restart_error());
          }),
      );
  };

  const label = computerLabel(computer);
  const updateAvailable = isComputerUpdateAvailable(
    computer.computerVersion,
    latestComputerVersion,
  );
  const versionState = !computer.computerVersion
    ? undefined
    : updateAvailable && latestComputerVersion
      ? m.computer_new_version({ version: latestComputerVersion })
      : latestComputerVersion
        ? m.computer_up_to_date()
        : undefined;

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-secondary px-4 sm:px-8">
        <BackToComputers />
        <ComputerTile computer={computer} />
        <h1 className="min-w-0 truncate text-md font-semibold text-primary">{label}</h1>
      </div>

      <div className="min-h-0 flex-1 divide-y divide-secondary overflow-y-auto">
        <div className="flex items-center gap-4 px-4 py-6 sm:px-8">
          <ComputerTile computer={computer} size="xl" />
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold text-primary">{label}</p>
            <p className="mt-1 flex items-center gap-2 text-sm text-secondary">
              <StatusDot tone={computer.online ? "online" : "offline"} className="size-2" />
              {computer.online ? m.computer_status_online() : m.computer_status_offline()}
            </p>
            {computer.name && computer.name !== label && (
              <p className="mt-1 truncate font-mono text-sm text-tertiary">{computer.name}</p>
            )}
          </div>
        </div>

        <DetailGroup
          heading={m.computer_display_name()}
          headingId="computer-display-name"
          action={
            canEditDisplayName && !editingDisplayName ? (
              <ButtonUtility
                type="button"
                size="xs"
                color="tertiary"
                icon={Pencil}
                aria-label={m.computer_display_name_edit()}
                onClick={() => {
                  setDisplayNameDraft(computer.displayName);
                  setDisplayNameError(false);
                  setEditingDisplayName(true);
                }}
              />
            ) : undefined
          }
          plain
        >
          {editingDisplayName ? (
            <form
              className="max-w-sm"
              onSubmit={async (event) => {
                event.preventDefault();
                if (!onUpdateDisplayName) return;
                setSavingDisplayName(true);
                setDisplayNameError(false);
                try {
                  await onUpdateDisplayName(displayNameDraft);
                  setEditingDisplayName(false);
                } catch {
                  setDisplayNameError(true);
                } finally {
                  setSavingDisplayName(false);
                }
              }}
              onKeyDown={(event) => {
                if (event.key !== "Escape" || savingDisplayName) return;
                setDisplayNameDraft(computer.displayName);
                setDisplayNameError(false);
                setEditingDisplayName(false);
              }}
            >
              <Input
                aria-label={m.computer_display_name()}
                size="sm"
                autoFocus
                isRequired
                maxLength={200}
                value={displayNameDraft}
                isDisabled={savingDisplayName}
                onChange={setDisplayNameDraft}
              />
              <div className="mt-2 flex gap-2">
                <Button type="submit" size="sm" isDisabled={savingDisplayName}>
                  {savingDisplayName
                    ? m.computer_display_name_saving()
                    : m.computer_display_name_save()}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  color="secondary"
                  isDisabled={savingDisplayName}
                  onPress={() => {
                    setDisplayNameDraft(computer.displayName);
                    setDisplayNameError(false);
                    setEditingDisplayName(false);
                  }}
                >
                  {m.computer_display_name_cancel()}
                </Button>
              </div>
              {displayNameError && (
                <p role="alert" className="mt-2 text-sm text-error-primary">
                  {m.computer_display_name_error()}
                </p>
              )}
            </form>
          ) : (
            <p className="truncate text-sm font-medium text-primary">{label}</p>
          )}
        </DetailGroup>

        <DetailGroup heading={m.computer_info()} headingId="computer-info" plain>
          <dl className="grid gap-x-8 gap-y-6 md:grid-cols-2 xl:grid-cols-3">
            <Field label={m.computer_os()} value={operatingSystemLabel(computer)} mono />
            <Field
              label={m.computer_version()}
              value={
                <>
                  <span className="font-mono">{computerVersionLabel(computer)}</span>
                  {versionState && (
                    <span className="font-normal text-tertiary"> · {versionState}</span>
                  )}
                </>
              }
            />
            <Field
              label={m.computer_connected_at()}
              value={<ComputerDate value={computer.connectedAt} timeZone={timeZone} />}
            />
            {computer.creator && (
              <Field
                label={m.computer_added_by()}
                value={
                  <span className="flex min-w-0 items-center gap-2">
                    <Avatar
                      size="xs"
                      src={computer.creator.avatarUrl}
                      alt=""
                      initials={avatarInitial(creatorName)}
                      contentClassName={avatarToneClassName(creatorName)}
                    />
                    <span className="truncate">{creatorName}</span>
                  </span>
                }
              />
            )}
            <Field
              wide
              label={m.computer_code_agents()}
              value={
                computer.runtimes.length ? (
                  <ul className="flex flex-wrap gap-2">
                    {computer.runtimes.map((runtime) => (
                      <li key={runtime.provider}>
                        {computer.ownedByCurrentUser ? (
                          <RuntimeUsage
                            computerId={computer.id}
                            runtime={runtime}
                            computerOnline={computer.online}
                            timeZone={timeZone}
                            triggerClassName={RUNTIME_CHIP_TRIGGER_CLASS_NAME}
                            trigger={(health) => <RuntimeChip runtime={runtime} health={health} />}
                          />
                        ) : (
                          <RuntimeChip runtime={runtime} />
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="font-normal text-tertiary">{m.computer_no_code_agents()}</span>
                )
              }
            />
          </dl>
        </DetailGroup>

        <AgentRoster
          agents={computer.agents}
          onCreateAgent={
            onCreateAgent && onLoadRuntimeCatalog ? () => setCreateAgentOpen(true) : undefined
          }
          onSelectAgent={onSelectAgent}
          onExecute={onExecuteAgentControl}
          canFullReset={computer.canManageAgents}
          computerOnline={computer.online}
          computerName={label}
        />
        <WorkspaceInventory
          scan={workspaceScan}
          canScan={Boolean(onScanAgentWorkspaces)}
          onScan={() => void scanWorkspaces()}
          canDelete={Boolean(onDeleteAgentWorkspace)}
          onDelete={async (agentId) => {
            if (!onDeleteAgentWorkspace) return;
            const result = await onDeleteAgentWorkspace(agentId);
            if (result.status !== "ok" && result.status !== "missing")
              throw new Error("Workspace could not be deleted");
            await scanWorkspaces();
          }}
        />

        {computer.ownedByCurrentUser && computer.runtimes.length > 0 && (
          <DetailGroup heading={m.computer_runtime_visibility()} headingId="computer-runtimes">
            <ul className="divide-y divide-secondary">
              {computer.runtimes.map((runtime) => (
                <li
                  key={runtime.provider}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-4 py-3 text-sm"
                >
                  <RuntimeIdentity runtime={runtime} />
                  <Toggle
                    className="shrink-0"
                    label={m.computer_runtime_public()}
                    aria-label={m.computer_runtime_public_label({
                      runtime: runtime.displayName,
                    })}
                    isSelected={runtime.isPublic}
                    isDisabled={updatingRuntimeIdsState.has(runtime.id)}
                    onChange={(isPublic) => void setRuntimePublic(runtime.id, isPublic)}
                  />
                  {runtimeVisibilityErrorIds.has(runtime.id) && (
                    <p role="alert" className="basis-full text-xs text-error-primary">
                      {m.computer_runtime_visibility_error()}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </DetailGroup>
        )}

        <DetailGroup heading={m.computer_actions()} headingId="computer-actions">
          <div className="py-4">
            <h3 className="text-sm font-semibold text-primary">{m.computer_actions_computer()}</h3>
            {(!computer.online || versionState) && (
              <p className="mt-1 text-sm text-tertiary">
                {computer.online ? versionState : m.computer_status_offline()}
              </p>
            )}
            {(onRestart || upgradeButton) && (
              <div className="mt-3 flex flex-wrap gap-2">
                {onRestart && (
                  <Button
                    type="button"
                    size="sm"
                    color="secondary"
                    iconLeading={RotateCw}
                    isDisabled={
                      upgrading || restartState === "pending" || restartState === "accepted"
                    }
                    onPress={runRestart}
                  >
                    {restartState === "pending"
                      ? m.computer_restart_requesting()
                      : m.computer_restart_action()}
                  </Button>
                )}
                {upgradeButton}
              </div>
            )}
            {upgrade.state === "failed" && (
              <div role="alert" className="mt-3 text-sm text-error-primary">
                <p>{upgrade.headline}</p>
                {upgrade.steps.length > 0 && (
                  <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-sm text-tertiary">
                    {upgrade.steps.map((step, index) => (
                      <li key={index}>
                        {step.text}
                        {step.command && (
                          <>
                            {" "}
                            <UpgradeCommand command={step.command} />
                          </>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
                {upgrade.errorId && (
                  <p className="mt-1.5 text-xs text-tertiary">
                    {m.error_reference({ errorId: upgrade.errorId })}
                  </p>
                )}
              </div>
            )}
          </div>
          {computer.ownedByCurrentUser && (
            <div className="border-t border-secondary py-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-primary">
                <Terminal aria-hidden="true" className="size-4 text-fg-quaternary" />
                {m.computer_verify_terminal()}
              </h3>
              <p className="mt-1 text-sm text-tertiary">
                {m.computer_verify_terminal_description()}
              </p>
              <div className="mt-3 space-y-2">
                <TerminalCommand command="coforge-computer status" />
                <TerminalCommand command="coforge-computer logs" />
              </div>
              <p className="mt-4 text-sm text-tertiary">{m.computer_restart_from_terminal()}</p>
              <div className="mt-2">
                <TerminalCommand
                  command={`coforge-computer restart --workspace ${workspaceSlug}`}
                />
              </div>
            </div>
          )}
        </DetailGroup>

        {onDeleteComputer && (
          <div className="flex flex-col gap-4 px-4 py-6 sm:flex-row sm:items-center sm:justify-between sm:px-8">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-primary">{m.computer_delete_action()}</h2>
              <p className="mt-1 text-sm text-tertiary">{m.computer_delete_description()}</p>
            </div>
            <Button
              type="button"
              size="sm"
              color="secondary-destructive"
              iconLeading={Trash}
              className="shrink-0 self-start sm:self-auto"
              onPress={() => setDeleteOpen(true)}
            >
              {m.computer_delete_action()}
            </Button>
          </div>
        )}
      </div>
      {onDeleteComputer && (
        <ComputerDeleteDialog
          computerName={label}
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          onDelete={onDeleteComputer}
        />
      )}
      {onCreateAgent && onLoadRuntimeCatalog && (
        <AgentCreateDialog
          open={createAgentOpen}
          onOpenChange={setCreateAgentOpen}
          computers={[
            {
              id: computer.id,
              name: computer.name,
              displayName: computer.displayName,
              online: computer.online,
              runtimes: computer.runtimes.map((runtime) => ({ provider: runtime.provider })),
            },
          ]}
          defaults={{ computerId: computer.id }}
          computerLocked
          onCreate={onCreateAgent}
          onLoadRuntimeCatalog={onLoadRuntimeCatalog}
        />
      )}
    </>
  );
}

function AgentRoster({
  agents,
  onCreateAgent,
  onSelectAgent,
  onExecute,
  canFullReset,
  computerOnline,
  computerName,
}: {
  agents: ComputerDetailView["agents"];
  onCreateAgent?: () => void;
  onSelectAgent?: (agentId: string) => void;
  onExecute?: AgentControlExecute;
  canFullReset: boolean;
  computerOnline: boolean;
  computerName: string;
}) {
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failedNames, setFailedNames] = useState<string[]>([]);
  const selectedAgents = agents.filter((agent) => selectedIds.has(agent.id));
  const selectionName = selectedAgents.map((agent) => agent.displayName).join(", ");
  const control = useAgentRuntimeControls({
    agentId: selectedAgents[0]?.id ?? "",
    agentName: selectionName,
    canFullReset,
    computerOnline,
    computerLabel: computerName,
    onExecute: async (request) => {
      if (!onExecute || !selectedAgents.length || busy) return;
      setBusy(true);
      setFailedNames([]);
      try {
        const results = await Promise.allSettled(
          selectedAgents.map((agent) =>
            onExecute({ ...request, agentId: agent.id, requestId: crypto.randomUUID() }),
          ),
        );
        const failed = selectedAgents.filter(
          (_agent, index) => results[index]?.status === "rejected",
        );
        setFailedNames(failed.map((agent) => agent.displayName));
        if (failed.length) throw new Error("Some Agent control requests failed");
      } finally {
        setBusy(false);
      }
    },
  });
  const locked = busy || control.stopConfirmOpen || control.restartOpen;
  return (
    <>
      <DetailGroup
        heading={`${m.computer_agents_on_computer()} (${agents.length})`}
        headingId="computer-agents-on-computer"
        action={
          <div className="flex flex-wrap justify-end gap-2">
            {selecting ? (
              <>
                <Button
                  size="sm"
                  color="secondary"
                  isDisabled={locked}
                  onPress={() =>
                    setSelectedIds(
                      selectedAgents.length === agents.length
                        ? new Set()
                        : new Set(agents.map((agent) => agent.id)),
                    )
                  }
                >
                  {selectedAgents.length === agents.length
                    ? m.computer_agents_clear_all()
                    : m.computer_agents_select_all()}
                </Button>
                <Button
                  size="sm"
                  color="tertiary"
                  isDisabled={locked}
                  onPress={() => {
                    setSelecting(false);
                    setSelectedIds(new Set());
                    setFailedNames([]);
                  }}
                >
                  {m.controls_cancel()}
                </Button>
              </>
            ) : (
              <>
                {onExecute && agents.length > 0 && (
                  <Button size="sm" color="secondary" onPress={() => setSelecting(true)}>
                    {m.computer_agent_select()}
                  </Button>
                )}
                {onCreateAgent && (
                  <Button size="sm" color="secondary" iconLeading={Plus} onPress={onCreateAgent}>
                    {m.computer_agent_create()}
                  </Button>
                )}
              </>
            )}
          </div>
        }
      >
        {selecting && selectedAgents.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 py-3">
            <span className="mr-auto text-sm text-tertiary">
              {m.computer_agents_selected({ count: String(selectedAgents.length) })}
            </span>
            <Button
              size="sm"
              color="secondary"
              isDisabled={locked}
              onPress={control.pressStartOrStop}
            >
              {m.agent_control_start()}
            </Button>
            <Button
              size="sm"
              color="secondary"
              isDisabled={locked}
              onPress={() => control.setStopConfirmOpen(true)}
            >
              {m.agent_control_stop()}
            </Button>
            <Button
              size="sm"
              color="secondary"
              isDisabled={locked}
              onPress={() => control.openRestart()}
            >
              {m.agent_control_restart_reset_tooltip()}
            </Button>
          </div>
        )}
        {failedNames.length > 0 && (
          <p role="alert" className="py-2 text-sm text-error-primary">
            {m.computer_agents_control_failed({ names: failedNames.join(", ") })}
          </p>
        )}
        {control.startDeferred && (
          <p className="py-2 text-sm text-tertiary">
            {m.agent_control_start_deferred_notice({ computer: computerName })}
          </p>
        )}
        {agents.length ? (
          <ul className="divide-y divide-secondary">
            {agents.map((agent) => {
              const handle = (
                <span className="ml-auto shrink-0 text-xs text-tertiary">@{agent.name}</span>
              );
              const toggle = (selected: boolean) =>
                setSelectedIds((current) => {
                  const next = new Set(current);
                  if (selected) next.add(agent.id);
                  else next.delete(agent.id);
                  return next;
                });
              return (
                <li key={agent.id}>
                  {selecting ? (
                    // While selecting, the whole row is the checkbox's own label: one control, so a
                    // click anywhere toggles selection and nothing interactive nests inside
                    // anything else interactive. Same shape as the channel member picker.
                    <AriaCheckbox
                      aria-label={m.computer_agent_select_named({ name: agent.displayName })}
                      isDisabled={locked}
                      isSelected={selectedIds.has(agent.id)}
                      onChange={toggle}
                      className="flex w-full cursor-pointer items-center gap-3 py-3 text-sm hover:bg-primary_hover disabled:cursor-not-allowed"
                    >
                      {({ isSelected, isDisabled, isFocusVisible }) => (
                        <>
                          <CheckboxBase
                            isSelected={isSelected}
                            isDisabled={isDisabled}
                            isFocusVisible={isFocusVisible}
                          />
                          <AgentRosterIdentity agent={agent} />
                          {handle}
                        </>
                      )}
                    </AriaCheckbox>
                  ) : onSelectAgent ? (
                    // Otherwise the row itself opens the Agent — no trailing "Open" button to aim
                    // at. Its accessible name is its own content (name, runtime, handle). The
                    // official Button carries the row: `h-auto`/`py-3` keep the list's rhythm,
                    // `rounded-none px-0` let the hover fill the row, and `font-normal` leaves the
                    // runtime line at its own weight instead of the Button's semibold.
                    <Button
                      color="tertiary"
                      size="sm"
                      onPress={() => onSelectAgent(agent.id)}
                      className="h-auto w-full justify-start rounded-none px-0 py-3 text-left font-normal *:data-text:w-full *:data-text:min-w-0"
                    >
                      <span className="flex w-full min-w-0 items-center gap-3">
                        <AgentRosterIdentity agent={agent} />
                        {handle}
                      </span>
                    </Button>
                  ) : (
                    <span className="flex w-full items-center gap-3 py-3 text-sm">
                      <AgentRosterIdentity agent={agent} />
                      {handle}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="py-6 text-center text-sm text-tertiary">
            {m.computer_no_agents_on_computer()}
          </p>
        )}
      </DetailGroup>
      <AgentControlDialogs agentName={selectionName} control={control} />
    </>
  );
}

function AgentRosterIdentity({ agent }: { agent: ComputerDetailView["agents"][number] }) {
  const display = useLiveAgentDisplay(agent.id) ?? agent.display;
  return (
    <>
      <AgentDisplayAvatar name={agent.displayName} src={agent.avatarUrl} display={display} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-primary">{agent.displayName}</span>
        <span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-tertiary">
          <RuntimeProviderMark provider={agent.provider} className="size-3.5" />
          <span className="truncate">
            {runtimeProviderLabel(agent.provider)}
            {agent.runtimeConfig.model ? ` · ${agent.runtimeConfig.model}` : ""}
          </span>
        </span>
      </span>
    </>
  );
}

function WorkspaceInventory({
  scan,
  canScan,
  onScan,
  canDelete,
  onDelete,
}: {
  scan:
    | { state: "idle" }
    | { state: "scanning" }
    | { state: "ready"; workspaces: ComputerAgentWorkspaceScan[] }
    | { state: "error" };
  canScan: boolean;
  onScan: () => void;
  canDelete: boolean;
  onDelete: (agentId: string) => Promise<void>;
}) {
  const [deletingAgentId, setDeletingAgentId] = useState<string | undefined>();
  const [deleteError, setDeleteError] = useState(false);
  const deleteWorkspace = async (workspace: ComputerAgentWorkspaceScan) => {
    if (
      !window.confirm(
        `Delete all files in ${workspace.displayName}'s workspace? This cannot be undone.`,
      )
    )
      return;
    setDeletingAgentId(workspace.agentId);
    setDeleteError(false);
    try {
      await onDelete(workspace.agentId);
    } catch {
      setDeleteError(true);
    } finally {
      setDeletingAgentId(undefined);
    }
  };
  const deletedCount =
    scan.state === "ready" ? scan.workspaces.filter((item) => item.state === "deleted").length : 0;
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
            iconLeading={Scan}
            isLoading={scan.state === "scanning"}
            showTextWhileLoading
            onPress={onScan}
          >
            {scan.state === "scanning"
              ? m.computer_agent_workspaces_scanning()
              : m.computer_agent_workspaces_scan()}
          </Button>
        ) : undefined
      }
    >
      {scan.state === "idle" ? (
        <p className="py-4 text-sm text-tertiary">{m.computer_agent_workspaces_prompt()}</p>
      ) : scan.state === "error" ? (
        <p role="alert" className="py-4 text-sm text-error-primary">
          {m.computer_agent_workspaces_error()}
        </p>
      ) : scan.state === "scanning" ? (
        <p className="py-4 text-sm text-tertiary">{m.computer_agent_workspaces_scanning()}</p>
      ) : scan.workspaces.length ? (
        <>
          {deletedCount > 0 && (
            <p className="py-3 text-sm text-tertiary">
              {m.computer_agent_workspaces_deleted_summary({ count: String(deletedCount) })}
            </p>
          )}
          {deleteError && (
            <p role="alert" className="py-2 text-sm text-error-primary">
              {m.computer_agent_workspace_delete_error()}
            </p>
          )}
          <ul className="divide-y divide-secondary">
            {scan.workspaces.map((workspace) => (
              <li
                key={workspace.agentId}
                className="flex min-w-0 items-start justify-between gap-4 py-3 text-sm"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-primary">
                      {workspace.displayName}
                    </span>
                    <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-tertiary">
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
                    color="tertiary"
                    isLoading={deletingAgentId === workspace.agentId}
                    isDisabled={deletingAgentId !== undefined}
                    onPress={() => void deleteWorkspace(workspace)}
                  >
                    {m.computer_agent_workspace_delete()}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="py-4 text-sm text-tertiary">{m.computer_agent_workspaces_none()}</p>
      )}
    </DetailGroup>
  );
}

function formatWorkspaceSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * One section of the detail panel. Sections run full width and are separated by the panel's own
 * dividers; the heading row carries the section's one action. Rows that form a list sit on the
 * subtle fill, while `plain` content (a single value, a field grid) sits on the panel itself.
 */
function DetailGroup({
  heading,
  headingId,
  action,
  plain = false,
  children,
}: {
  heading: string;
  headingId: string;
  action?: ReactNode;
  plain?: boolean;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={headingId} className="px-4 py-6 sm:px-8">
      <div className="mb-3 flex min-h-9 items-center justify-between gap-3">
        <h2 id={headingId} className="text-sm font-semibold text-primary">
          {heading}
        </h2>
        {action}
      </div>
      {plain ? children : <div className="rounded-xl bg-secondary px-4">{children}</div>}
    </section>
  );
}

/** One fact in the Info grid: label above, value below. `wide` takes the whole row. */
function Field({
  label,
  value,
  mono = false,
  wide = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={cn("min-w-0", wide && "md:col-span-2 xl:col-span-3")}>
      <dt className="text-sm text-tertiary">{label}</dt>
      <dd className={cn("mt-1 min-w-0 text-sm font-medium text-primary", mono && "font-mono")}>
        {value}
      </dd>
    </div>
  );
}

const RUNTIME_CHIP_TRIGGER_CLASS_NAME =
  "rounded-full outline-none data-focus-visible:ring-2 data-focus-visible:ring-brand";

/** A detected runtime as a compact chip, with its usage health when the viewer may see it. */
function RuntimeChip({ runtime, health }: { runtime: Runtime; health?: UsageHealth }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-secondary bg-primary py-1 pr-2.5 pl-1.5 text-xs font-medium text-secondary">
      <RuntimeProviderMark provider={runtime.provider} className="size-4" />
      {runtime.displayName}
      <UsageHealthDot health={health} />
    </span>
  );
}

/** The day this Computer joined the Workspace, in the viewer's zone once the page is hydrated. */
function ComputerDate({ value, timeZone }: { value: Date | string; timeZone: string | null }) {
  const hydrated = useHydrated();
  const instant = new Date(value).toISOString();
  return (
    <time dateTime={instant}>
      {hydrated ? formatCalendarDate(value, timeZone, getLocale()) : " "}
    </time>
  );
}

/** A command to run on the Computer itself, in a mono block with a copy control. */
function TerminalCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg bg-primary py-2 pr-2 pl-3 ring-1 ring-secondary ring-inset">
      <code className="min-w-0 flex-1 truncate font-mono text-sm text-secondary">{command}</code>
      <ButtonUtility
        icon={copied ? Check : Copy}
        size="xs"
        color="tertiary"
        aria-label={m.computer_copy_terminal_command()}
        onClick={() => {
          void navigator.clipboard.writeText(command);
          setCopied(true);
        }}
      />
    </div>
  );
}

/** Confirms deleting the Computer from the Workspace; a refusal stays in the dialog. */
function ComputerDeleteDialog({
  computerName,
  open,
  onOpenChange,
  onDelete,
}: {
  computerName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: () => Promise<void>;
}) {
  const [error, setError] = useState(false);
  const [deleting, guard] = useSubmitGuard();
  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(nextOpen: boolean) => {
        if (deleting) return;
        setError(false);
        onOpenChange(nextOpen);
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-lg">
        <Dialog className="overflow-hidden text-left">
          {({ close }) => (
            <>
              <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-6">
                <Heading
                  slot="title"
                  className="min-w-0 text-xl font-semibold text-primary wrap-anywhere sm:text-display-xs"
                >
                  {m.computer_delete_dialog_title({ name: computerName })}
                </Heading>
                <ButtonUtility
                  aria-label={m.controls_close()}
                  icon={X}
                  size="sm"
                  color="tertiary"
                  isDisabled={deleting}
                  onClick={close}
                />
              </div>
              <div className="mx-6 mt-4 flex items-start gap-3">
                <FeaturedIcon color="error" theme="light" size="sm" icon={AlertCircle} />
                <Text slot="description" className="text-sm text-secondary">
                  {m.computer_delete_description()}
                </Text>
              </div>
              {error && (
                <p role="alert" className="px-6 pt-4 text-sm text-error-primary">
                  {m.computer_delete_error()}
                </p>
              )}
              <div className="mt-6 flex shrink-0 flex-wrap justify-end gap-3 border-t border-secondary px-6 py-4">
                <Button color="secondary" isDisabled={deleting} onPress={close}>
                  {m.controls_cancel()}
                </Button>
                <Button
                  color="primary-destructive"
                  isLoading={deleting}
                  showTextWhileLoading
                  onPress={() => {
                    if (deleting) return;
                    setError(false);
                    void guard(async () => {
                      try {
                        await onDelete();
                      } catch {
                        setError(true);
                      }
                    });
                  }}
                >
                  {m.computer_delete_action()}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/** The part a reader distinguishes releases by: `0.1.0-dev.29` reads as `dev.29`. */
function shortReleaseVersion(version: string) {
  const tail = version.split("-").at(-1);
  return tail && tail !== version ? tail : version;
}

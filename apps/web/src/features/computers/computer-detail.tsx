import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle,
  ArrowUp,
  Check,
  ChevronRight,
  Copy01 as Copy,
  Edit01 as Pencil,
  Plus,
  FolderSearch,
  Globe01,
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
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { formatCalendarDate, formatDateForDisplay } from "#src/lib/dates";
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
import { RuntimeUsage, UsageHealthDot, type UsageHealth } from "./runtime-usage";
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
import type { AgentWorkspaceScanSnapshot } from "./agent-workspace-scan.query";

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
  agentWorkspaceScan = null,
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
  /** The last Agent workspace scan the owner took (kept across reloads); `null` when none. */
  agentWorkspaceScan?: AgentWorkspaceScanSnapshot | null;
  /** Scans the Computer and records the result as `agentWorkspaceScan`. */
  onScanAgentWorkspaces?: () => Promise<void>;
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
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState(computer.displayName);
  const [savingDisplayName, setSavingDisplayName] = useState(false);
  const [displayNameError, setDisplayNameError] = useState(false);
  // Only the scan in progress lives here; its result is `agentWorkspaceScan`, which outlives a
  // reload. A failed scan leaves the last result on screen beside the error.
  const [workspaceScanStatus, setWorkspaceScanStatus] = useState<"idle" | "scanning" | "error">(
    "idle",
  );
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [updatingRuntimeIds, setUpdatingRuntimeIds] = useState<ReadonlySet<string>>(new Set());
  const [runtimeVisibilityErrorIds, setRuntimeVisibilityErrorIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const setRuntimePublic = async (runtimeId: string, isPublic: boolean) => {
    const without = (ids: ReadonlySet<string>) =>
      new Set([...ids].filter((id) => id !== runtimeId));
    setUpdatingRuntimeIds((ids) => new Set(ids).add(runtimeId));
    setRuntimeVisibilityErrorIds(without);
    try {
      await onSetRuntimePublic(runtimeId, isPublic);
    } catch {
      setRuntimeVisibilityErrorIds((ids) => new Set(ids).add(runtimeId));
    } finally {
      setUpdatingRuntimeIds(without);
    }
  };
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
  const canUpgrade = Boolean(onUpgrade) && computer.ownedByCurrentUser;
  const upgradeAvailable =
    canUpgrade && isComputerUpdateAvailable(computer.computerVersion, latestComputerVersion);
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
  const scanWorkspaces = async () => {
    if (!onScanAgentWorkspaces) return;
    setWorkspaceScanStatus("scanning");
    try {
      await onScanAgentWorkspaces();
      setWorkspaceScanStatus("idle");
    } catch {
      setWorkspaceScanStatus("error");
    }
  };

  // Upgrade shows for the owner only while there is something to do: a newer release is known, or
  // an upgrade is running. With no update the Version row is just the version (task #107). A
  // failed upgrade keeps it, since the newer release is still known and the button is the retry.
  // Offline with an update known, it stays visible but disabled.
  const upgradeButton =
    canUpgrade && (upgradeAvailable || upgrading) ? (
      <Button
        type="button"
        size="sm"
        color="secondary"
        iconLeading={ArrowUp}
        isLoading={upgrading}
        showTextWhileLoading
        isDisabled={upgrading || !upgradeAvailable || !computer.online}
        onPress={() => void runUpgrade()}
      >
        {upgrading
          ? m.computer_upgrade_in_progress()
          : upgradeAvailable && latestComputerVersion
            ? m.computer_upgrade_action({ version: shortReleaseVersion(latestComputerVersion) })
            : m.computer_upgrade()}
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

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-secondary px-4 sm:px-6">
        <BackToComputers />
        {onRestart && (
          <Button
            type="button"
            size="sm"
            color="secondary"
            className="ml-auto"
            iconLeading={RotateCw}
            isDisabled={upgrading || restartState === "pending" || restartState === "accepted"}
            onPress={runRestart}
          >
            {restartState === "pending"
              ? m.computer_restart_requesting()
              : m.computer_restart_action()}
          </Button>
        )}
      </div>

      <div className="@container min-h-0 flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
        <div className="mx-auto flex w-full max-w-[40rem] flex-col gap-8">
          <div className="flex flex-col items-center gap-3 text-center">
            <ComputerTile computer={computer} online={computer.online} size="xl" />
            {editingDisplayName ? (
              <form
                className="w-full max-w-sm"
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
                <div className="mt-2 flex justify-center gap-2">
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
              // The pencil hangs off the name's right edge so the name itself stays centred.
              <div className="relative max-w-[calc(100%-5rem)]">
                <h1 className="truncate text-display-sm font-semibold text-primary">{label}</h1>
                {canEditDisplayName && (
                  <ButtonUtility
                    type="button"
                    size="sm"
                    color="tertiary"
                    icon={Pencil}
                    className="absolute top-1/2 left-full ml-1 -translate-y-1/2"
                    aria-label={m.computer_display_name_edit()}
                    onClick={() => {
                      setDisplayNameDraft(computer.displayName);
                      setDisplayNameError(false);
                      setEditingDisplayName(true);
                    }}
                  />
                )}
              </div>
            )}
          </div>

          <DetailGroup>
            <dl className="divide-y divide-secondary">
              <DetailRow
                label={m.computer_hostname()}
                value={<span className="font-mono">{computer.name}</span>}
              />
              <DetailRow label={m.computer_system()} value={operatingSystemLabel(computer)} />
              <DetailRow
                label={m.computer_version()}
                value={<span className="font-mono">{computerVersionLabel(computer)}</span>}
                action={upgradeButton}
                footer={
                  upgrade.state === "failed" ? (
                    <div role="alert" className="mt-1.5 text-sm text-error-primary">
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
                  ) : undefined
                }
              />
              {computer.creator && (
                <DetailRow
                  label={m.computer_added_by()}
                  value={
                    <span className="flex min-w-0 items-center justify-end gap-2">
                      <Avatar
                        size="xs"
                        src={computer.creator.avatarUrl}
                        alt=""
                        initials={avatarInitial(creatorName)}
                        contentClassName={avatarToneClassName(creatorName)}
                      />
                      <span className="truncate">
                        {creatorName} ·{" "}
                        <ComputerDate value={computer.connectedAt} timeZone={timeZone} />
                      </span>
                    </span>
                  }
                />
              )}
            </dl>
            <div className="border-t border-secondary py-3">
              <h3 className="text-sm font-medium text-primary">{m.computer_runtimes()}</h3>
              {computer.runtimes.length ? (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {computer.runtimes.map((runtime) => (
                    <li key={runtime.provider}>
                      {computer.ownedByCurrentUser ? (
                        <RuntimeUsage
                          computerId={computer.id}
                          runtime={runtime}
                          computerOnline={computer.online}
                          timeZone={timeZone}
                          triggerClassName={RUNTIME_CHIP_TRIGGER_CLASS_NAME}
                          trigger={(health) => (
                            <RuntimeChip
                              runtime={runtime}
                              health={health}
                              isPublic={runtime.isPublic}
                            />
                          )}
                          footer={
                            <>
                              <div className="flex items-center justify-between gap-4">
                                <span className="text-sm font-medium text-secondary">
                                  {m.computer_runtime_public()}
                                </span>
                                {/* A disabled toggle drops focus to the page mid-press and the
                                    hover peek closes with it (task #116; the refresh bug #179 went
                                    down this exact path). Repeat edits are ignored in the handler
                                    instead; the error text below still reports a failed change. */}
                                <Toggle
                                  size="sm"
                                  aria-label={m.computer_runtime_public()}
                                  isSelected={runtime.isPublic}
                                  aria-busy={updatingRuntimeIds.has(runtime.id) || undefined}
                                  onChange={(isPublic) => {
                                    if (!updatingRuntimeIds.has(runtime.id))
                                      void setRuntimePublic(runtime.id, isPublic);
                                  }}
                                />
                              </div>
                              {runtimeVisibilityErrorIds.has(runtime.id) && (
                                <p role="alert" className="mt-2 text-xs text-error-primary">
                                  {m.computer_runtime_visibility_error()}
                                </p>
                              )}
                            </>
                          }
                        />
                      ) : (
                        <RuntimeChip runtime={runtime} />
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-sm text-tertiary">{m.computer_no_code_agents()}</p>
              )}
            </div>
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
            snapshot={onScanAgentWorkspaces ? agentWorkspaceScan : null}
            status={workspaceScanStatus}
            timeZone={timeZone}
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

          {computer.ownedByCurrentUser && (
            <details className="group rounded-xl bg-secondary px-4">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 py-3 text-sm font-semibold text-primary outline-none focus-visible:ring-2 focus-visible:ring-brand [&::-webkit-details-marker]:hidden">
                <Terminal aria-hidden="true" className="size-4 text-fg-quaternary" />
                <span className="flex-1">{m.computer_troubleshoot_terminal()}</span>
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 text-fg-quaternary transition-transform group-open:rotate-90"
                />
              </summary>
              <div className="space-y-2 pb-4">
                <p className="text-sm text-tertiary">{m.computer_verify_terminal_description()}</p>
                <TerminalCommand command="coforge-computer status" />
                <TerminalCommand command="coforge-computer logs" />
                <p className="pt-2 text-sm text-tertiary">{m.computer_restart_from_terminal()}</p>
                <TerminalCommand
                  command={`coforge-computer restart --workspace ${workspaceSlug}`}
                />
              </div>
            </details>
          )}

          {onDeleteComputer && (
            <div className="flex flex-col gap-4 border-t border-secondary pt-6 sm:flex-row sm:items-center sm:justify-between">
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
      </div>
      {onDeleteComputer && (
        <DeleteConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title={m.computer_delete_dialog_title({ name: label })}
          description={m.computer_delete_description()}
          confirmLabel={m.computer_delete_action()}
          errorMessage={m.computer_delete_error()}
          onConfirm={onDeleteComputer}
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
      {status === "error" && (
        <p role="alert" className="py-4 text-sm text-error-primary">
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
      {!snapshot ? (
        status === "scanning" ? (
          <p className="py-4 text-sm text-tertiary">{m.computer_agent_workspaces_scanning()}</p>
        ) : status === "idle" ? (
          <p className="py-4 text-sm text-tertiary">{m.computer_agent_workspaces_prompt()}</p>
        ) : null
      ) : snapshot.workspaces.length ? (
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
        <p className="py-4 text-sm text-tertiary">{m.computer_agent_workspaces_none()}</p>
      )}
      <DeleteConfirmDialog
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

function formatWorkspaceSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * The subtle-fill container shared by the detail groups: no border, no
 * shadow, an optional heading inset to the row text, dividers between rows
 * supplied by the child list itself (`dl`/`ul` with `divide-y`).
 */
function DetailGroup({
  heading,
  headingId,
  action,
  children,
}: {
  heading?: string;
  headingId?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={headingId}>
      {(heading || action) && (
        <div className="mb-2 flex items-center justify-between gap-3 px-4">
          {heading && (
            <h2 id={headingId} className="text-sm font-semibold text-primary">
              {heading}
            </h2>
          )}
          {action}
        </div>
      )}
      <div className="rounded-xl bg-secondary px-4">{children}</div>
    </section>
  );
}

/**
 * One label—value row: label left, value (and an optional action that acts
 * on it) right, on a single line that never wraps. `footer` is an optional
 * full-width block below that line, such as an upgrade failure explanation.
 */
function DetailRow({
  label,
  value,
  action,
  footer,
}: {
  label: string;
  value: ReactNode;
  action?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="grid min-h-11 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 py-3 @max-md:items-start">
      <dt className="text-sm font-medium whitespace-nowrap text-primary">{label}</dt>
      {/* When the value and its action do not fit beside the label, the action drops below. */}
      <dd className="flex min-h-6 min-w-0 flex-wrap items-center justify-end gap-2 text-sm text-tertiary">
        <span className="min-w-0 truncate">{value}</span>
        {action && <span className="shrink-0">{action}</span>}
      </dd>
      {footer && <dd className="col-span-2">{footer}</dd>}
    </div>
  );
}

const RUNTIME_CHIP_TRIGGER_CLASS_NAME =
  "rounded-full outline-none data-focus-visible:ring-2 data-focus-visible:ring-brand";

/** A detected runtime as a compact chip: its mark and name, a globe when it is Public, and its
 * usage health when the viewer may see it. */
function RuntimeChip({
  runtime,
  health,
  isPublic = false,
}: {
  runtime: { provider: RuntimeProvider; displayName: string };
  health?: UsageHealth;
  isPublic?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-secondary bg-primary py-1 pr-2.5 pl-1.5 text-xs font-medium text-secondary hover:bg-primary_hover">
      <RuntimeProviderMark provider={runtime.provider} className="size-4" />
      {runtime.displayName}
      {isPublic && (
        <Globe01
          role="img"
          aria-label={m.computer_runtime_public()}
          className="size-3.5 text-fg-brand-secondary"
        />
      )}
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

/** Confirms an irreversible delete on this panel; a refusal stays in the dialog. */
function DeleteConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  errorMessage,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  errorMessage: string;
  /** Performs the delete; throws when it is refused. */
  onConfirm: () => Promise<void>;
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
                  {title}
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
                  {description}
                </Text>
              </div>
              {error && (
                <p role="alert" className="px-6 pt-4 text-sm text-error-primary">
                  {errorMessage}
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
                        await onConfirm();
                      } catch {
                        setError(true);
                      }
                    });
                  }}
                >
                  {confirmLabel}
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

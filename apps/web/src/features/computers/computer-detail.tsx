import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Check,
  Copy01 as Copy,
  Edit01 as Pencil,
  Plus,
  SearchLg as Scan,
  RefreshCw01 as RotateCw,
} from "@untitledui/icons";
import type { RuntimeProvider, AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { Avatar } from "#src/components/base/avatar/avatar";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { Toggle } from "#src/components/base/toggle/toggle";
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
import { RuntimeIdentity, RuntimeUsage } from "./runtime-usage";
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
            onPress={() => {
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
                    await new Promise((resolve) =>
                      window.setTimeout(resolve, restartPollIntervalMs),
                    );
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
            }}
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
                <h1 className="truncate text-display-sm font-semibold text-primary">
                  {computerLabel(computer)}
                </h1>
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
                      <span className="truncate">{creatorName}</span>
                    </span>
                  }
                />
              )}
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
            computerName={computerLabel(computer)}
          />
          <WorkspaceInventory
            scan={workspaceScan}
            canScan={Boolean(onScanAgentWorkspaces)}
            onScan={() => void scanWorkspaces()}
          />

          <section aria-labelledby="computer-code-agents">
            <DetailGroup heading={m.computer_code_agents()} headingId="computer-code-agents">
              {computer.runtimes.length ? (
                <ul className="divide-y divide-secondary">
                  {computer.runtimes.map((runtime) => (
                    <li
                      key={runtime.provider}
                      className="flex min-w-0 flex-wrap items-center justify-between gap-4 py-3 text-sm"
                    >
                      {computer.ownedByCurrentUser ? (
                        <RuntimeUsage
                          computerId={computer.id}
                          runtime={runtime}
                          computerOnline={computer.online}
                          timeZone={timeZone}
                        />
                      ) : (
                        <RuntimeIdentity runtime={runtime} />
                      )}
                      {computer.ownedByCurrentUser && (
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
                      )}
                      {computer.ownedByCurrentUser && runtimeVisibilityErrorIds.has(runtime.id) && (
                        <p role="alert" className="basis-full text-xs text-error-primary">
                          {m.computer_runtime_visibility_error()}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-6 text-center text-sm text-tertiary">
                  {m.computer_no_code_agents()}
                </p>
              )}
            </DetailGroup>
          </section>
        </div>
      </div>
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
            {agents.map((agent) => (
              <li
                key={agent.id}
                className="flex min-w-0 items-center justify-between gap-4 py-3 text-sm"
              >
                <span className="flex min-w-0 items-center gap-3">
                  {selecting && (
                    <Checkbox
                      aria-label={m.computer_agent_select_named({ name: agent.displayName })}
                      isDisabled={locked}
                      isSelected={selectedIds.has(agent.id)}
                      onChange={(selected) =>
                        setSelectedIds((current) => {
                          const next = new Set(current);
                          if (selected) next.add(agent.id);
                          else next.delete(agent.id);
                          return next;
                        })
                      }
                    />
                  )}
                  <AgentRosterIdentity agent={agent} />
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="text-xs text-tertiary">@{agent.name}</span>
                  {onSelectAgent && (
                    <Button
                      type="button"
                      size="sm"
                      color="tertiary"
                      onPress={() => onSelectAgent(agent.id)}
                    >
                      {m.computer_agent_open()}
                    </Button>
                  )}
                </span>
              </li>
            ))}
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
      <span className="min-w-0">
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
}: {
  scan:
    | { state: "idle" }
    | { state: "scanning" }
    | { state: "ready"; workspaces: ComputerAgentWorkspaceScan[] }
    | { state: "error" };
  canScan: boolean;
  onScan: () => void;
}) {
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
        <ul className="divide-y divide-secondary">
          {scan.workspaces.map((workspace) => (
            <li
              key={workspace.agentId}
              className="flex min-w-0 items-start justify-between gap-4 py-3 text-sm"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-primary">{workspace.displayName}</span>
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-tertiary">
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
              </div>
            </li>
          ))}
        </ul>
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
 * The subtle-fill container shared by both detail groups: no border, no
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
    <div>
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
    </div>
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

/** The part a reader distinguishes releases by: `0.1.0-dev.29` reads as `dev.29`. */
function shortReleaseVersion(version: string) {
  const tail = version.split("-").at(-1);
  return tail && tail !== version ? tail : version;
}

import { useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  Edit01 as Pencil,
  RefreshCw01 as RotateCw,
  Terminal,
  Trash01 as Trash,
} from "@untitledui/icons";
import { useQueries, useQueryClient } from "@tanstack/react-query";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { useAppToast } from "#src/components/ui/toast";
import { humanLabel } from "#src/lib/human-label";
import { m } from "#src/paraglide/messages";
import { TerminalCommand } from "./terminal-command";
import { FormatCloudComputerDialog } from "./format-cloud-computer-dialog";
import { ComputerDetailHeader } from "./computer-detail-header";
import {
  computerImageVersionLabel,
  computerLabel,
  computerVersionLabel,
  operatingSystemLabel,
} from "./computer-identity";
import { DetailGroup, DetailRow } from "./computer-detail-rows";
import { computerDetailUpgradeSlotsFor } from "./computer-detail-upgrade-slots";
import { computerUpgradeStatusQuery, upgradeRunning } from "./computer-upgrade-status";
import {
  describeUpgradeRequestError,
  upgradeOutcome,
  type ComputerUpgradeOutcome,
} from "./upgrade-failure";
import { submitComputerDetailUpgrade } from "./computer-detail-submit-upgrade";
import { ComputerTile } from "./computer-tile";
import {
  CloudImageUpdateDialog,
  ComputerUpgradeConfirmDialog,
  ComputerUpgradeSlot,
  type ComputerUpgradeRequest,
} from "./computer-upgrade-slot";
import { ComputerRuntimeList } from "./computer-runtimes";
import { AgentCreateDialog } from "#src/features/agents/agent-create-dialog";
import type { CreateAgentInput } from "#src/features/agents/agent.schemas";
import type { RuntimeCatalog } from "#src/features/agents/agent-runtime-fields";
import type { AgentControlExecute } from "#src/features/agents/agent-runtime-controls";
import type { ComputerRestartStatus, ComputerUpgradeStatus } from "./computer.schemas";
import type { AgentWorkspaceScanSnapshot } from "./agent-workspace-scan.query";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { ComputerRemoveAction } from "./computer-remove-action";
import { ComputerDetailAgentRoster } from "./computer-detail-agent-roster";
import { ComputerDate } from "./computer-detail-date";
import {
  RESTART_MAX_POLLS,
  RESTART_POLL_INTERVAL_MS,
  type ComputerDetailView,
} from "./computer-detail-view";
import { ComputerDetailWorkspaceInventory } from "./computer-detail-workspace-inventory";

export { RESTART_MAX_POLLS, RESTART_POLL_INTERVAL_MS, type ComputerDetailView };

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
  latestComputerVersion,
  restartPollIntervalMs = RESTART_POLL_INTERVAL_MS,
  restartMaxPolls = RESTART_MAX_POLLS,
  agentWorkspaceScan = null,
  onScanAgentWorkspaces,
  onDeleteAgentWorkspace,
  onRemoveComputer,
  onDeleteComputer,
  onFormatCloudComputer,
  onCreateAgent,
  onLoadRuntimeCatalog,
  onRescanRuntimes,
  onSelectAgent,
  onExecuteAgentControl,
}: {
  computer: ComputerDetailView;
  timeZone?: string | null;
  onSetRuntimePublic: (runtimeId: string, isPublic: boolean) => Promise<void>;
  onUpdateDisplayName?: (displayName: string) => Promise<void>;
  onRestart?: (requestId: string) => Promise<ComputerRestartStatus>;
  onReadRestartStatus?: (requestId: string) => Promise<ComputerRestartStatus>;
  onUpgrade?: (requestId: string, target?: "runtime" | "image") => Promise<ComputerUpgradeStatus>;
  /** The last Agent workspace scan the owner took (kept across reloads); `null` when none. */
  agentWorkspaceScan?: AgentWorkspaceScanSnapshot | null;
  /** Scans the Computer and records the result as `agentWorkspaceScan`. */
  onScanAgentWorkspaces?: () => Promise<void>;
  onDeleteAgentWorkspace?: (agentId: string) => Promise<{ status: string }>;
  onRemoveComputer?: () => Promise<void>;
  onDeleteComputer?: () => Promise<void>;
  /** Queues a disk format. The argument is the name the owner typed. */
  onFormatCloudComputer?: (confirmName: string) => Promise<void>;
  onCreateAgent?: (input: CreateAgentInput) => Promise<{ startPublished: boolean }>;
  onLoadRuntimeCatalog?: (computerId: string) => Promise<RuntimeCatalog[]>;
  /** Asks the Computer which runtimes it has, now; resolves whether it answered. */
  onRescanRuntimes?: () => Promise<boolean>;
  onSelectAgent?: (agentId: string) => void;
  onExecuteAgentControl?: AgentControlExecute;
  latestComputerVersion?: string | null;
  restartPollIntervalMs?: number;
  restartMaxPolls?: number;
}) {
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState(computer.displayName);
  const [savingDisplayName, setSavingDisplayName] = useState(false);
  const [displayNameError, setDisplayNameError] = useState(false);
  const [workspaceScanStatus, setWorkspaceScanStatus] = useState<"idle" | "scanning" | "error">(
    "idle",
  );
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [formatOpen, setFormatOpen] = useState(false);
  const [imageUpdateOpen, setImageUpdateOpen] = useState(false);
  const [upgradeConfirmOpen, setUpgradeConfirmOpen] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [rescanFailed, setRescanFailed] = useState(false);
  const rescan = async () => {
    if (!onRescanRuntimes || rescanning) return;
    setRescanning(true);
    setRescanFailed(false);
    try {
      setRescanFailed(!(await onRescanRuntimes()));
    } catch {
      setRescanFailed(true);
    } finally {
      setRescanning(false);
    }
  };
  const workspaceSlug = useWorkspaceSlug();
  const toast = useAppToast();
  const queryClient = useQueryClient();
  const creatorName = computer.creator ? humanLabel(computer.creator) : "";
  const mountedRef = useRef(true);
  useEffect(() => {
    // Set again on mount: StrictMode unmounts and remounts once in development.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [restartState, setRestartState] = useState<
    "idle" | "pending" | "accepted" | "completed" | "error"
  >("idle");
  const [upgradeRequest, setUpgradeRequest] = useState<ComputerUpgradeRequest>({ state: "idle" });
  const storedUpgrade = computer.upgrade ?? undefined;
  const followedUpgradeId =
    upgradeRequest.state === "accepted"
      ? upgradeRequest.requestId
      : storedUpgrade && upgradeRunning(storedUpgrade)
        ? storedUpgrade.requestId
        : null;
  const [liveStatus] = useQueries({
    queries: (followedUpgradeId ? [followedUpgradeId] : []).map((requestId) => ({
      ...computerUpgradeStatusQuery(computer.id, requestId),
      enabled: false,
    })),
  });
  const storedOutcome = storedUpgrade ? upgradeOutcome(storedUpgrade) : undefined;
  // A recovery fetch keeps the last error until it returns. The status it already holds is
  // what the slot shows while that read is in flight.
  const liveUpgrade: ComputerUpgradeOutcome | undefined = !liveStatus
    ? undefined
    : liveStatus.isError && !liveStatus.isFetching
      ? { state: "failed", failure: describeUpgradeRequestError(liveStatus.error) }
      : liveStatus.data
        ? upgradeOutcome(liveStatus.data)
        : upgradeRequest.state === "accepted"
          ? { state: "running" }
          : (storedOutcome ?? { state: "running" });
  // A stored success is history: the loader's version already includes it.
  const upgrade: ComputerUpgradeOutcome | { state: "idle" } =
    upgradeRequest.state === "requesting"
      ? { state: "running" }
      : upgradeRequest.state === "refused"
        ? { state: "failed", failure: upgradeRequest }
        : (liveUpgrade ??
          (storedOutcome && storedOutcome.state !== "succeeded"
            ? storedOutcome
            : { state: "idle" }));
  const upgrading = upgrade.state === "running";
  const {
    isCloud,
    currentVersion,
    currentImageVersion,
    runtimeSlot,
    imageSlot,
    runtimeOffer,
    imageOffer,
  } = computerDetailUpgradeSlotsFor(computer, {
    upgrade,
    request: upgradeRequest,
    liveStatus: liveStatus?.data,
    storedUpgrade,
    latestComputerVersion,
  });
  const canUpgrade = Boolean(onUpgrade) && computer.ownedByCurrentUser;
  const canEditDisplayName = computer.ownedByCurrentUser && Boolean(onUpdateDisplayName);
  const runUpgrade = (version: string | undefined, target: "runtime" | "image") =>
    submitComputerDetailUpgrade({
      computerId: computer.id,
      onUpgrade,
      queryClient,
      setUpgradeRequest,
      version,
      target,
    });
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
      <ComputerDetailHeader
        computerId={computer.id}
        showDesktop={isCloud && computer.ownedByCurrentUser}
        online={computer.online}
        restart={
          onRestart
            ? {
                pending: restartState === "pending",
                disabled: upgrading || restartState === "pending" || restartState === "accepted",
                onPress: runRestart,
              }
            : undefined
        }
      />

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
                value={
                  <span className="font-mono">
                    {computerVersionLabel({ computerVersion: currentVersion })}
                  </span>
                }
                footer={
                  runtimeSlot && (
                    <ComputerUpgradeSlot
                      slot={runtimeSlot}
                      canUpgrade={canUpgrade}
                      computerName={label}
                      cloud={false}
                      online={computer.online}
                      onUpgrade={() => setUpgradeConfirmOpen(true)}
                    />
                  )
                }
              />
              {isCloud && (
                <DetailRow
                  label={m.computer_image_version()}
                  value={
                    <span className="font-mono">
                      {computerImageVersionLabel({ imageVersion: currentImageVersion })}
                    </span>
                  }
                  footer={
                    imageSlot && (
                      <ComputerUpgradeSlot
                        slot={imageSlot}
                        canUpgrade={canUpgrade}
                        computerName={label}
                        cloud
                        online={computer.online}
                        onUpgrade={() => setImageUpdateOpen(true)}
                      />
                    )
                  }
                />
              )}
              {computer.creator && (
                <DetailRow
                  label={m.computer_added_by()}
                  value={
                    <span className="flex min-w-0 items-center justify-end gap-2">
                      <IdentityAvatar
                        size="xs"
                        name={creatorName}
                        src={computer.creator.avatarUrl}
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
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium text-primary">{m.computer_runtimes()}</h3>
                {onRescanRuntimes && computer.online && (
                  <Button
                    type="button"
                    size="xs"
                    color="secondary"
                    iconLeading={RotateCw}
                    isLoading={rescanning}
                    showTextWhileLoading
                    isDisabled={rescanning}
                    onPress={() => void rescan()}
                  >
                    {rescanning ? m.computer_runtime_rescanning() : m.computer_runtime_rescan()}
                  </Button>
                )}
              </div>
              {(rescanning || computer.runtimeDetecting) && (
                <p className="mt-1 text-sm text-tertiary" role="status">
                  {m.computer_runtime_detection_pending()}
                </p>
              )}
              {rescanFailed && !rescanning && (
                <p className="mt-1 text-sm text-error-primary" role="alert">
                  {m.computer_runtime_rescan_failed()}
                </p>
              )}
              {computer.runtimes.length ? (
                <ComputerRuntimeList
                  computer={computer}
                  timeZone={timeZone}
                  onSetRuntimePublic={onSetRuntimePublic}
                />
              ) : (
                <p className="mt-1 text-sm text-tertiary">{m.computer_no_code_agents()}</p>
              )}
            </div>
          </DetailGroup>

          <ComputerDetailAgentRoster
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
          <ComputerDetailWorkspaceInventory
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

          {onFormatCloudComputer && (
            <div className="flex flex-col gap-4 border-t border-secondary pt-6 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-primary">{m.computer_format_action()}</h2>
                <p className="mt-1 text-sm text-tertiary">{m.computer_format_description()}</p>
              </div>
              <Button
                type="button"
                size="sm"
                color="secondary-destructive"
                className="shrink-0 self-start sm:self-auto"
                onPress={() => setFormatOpen(true)}
              >
                {m.computer_format_action()}
              </Button>
            </div>
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
          {onRemoveComputer && <ComputerRemoveAction name={label} onConfirm={onRemoveComputer} />}
        </div>
      </div>
      {onFormatCloudComputer && (
        <FormatCloudComputerDialog
          open={formatOpen}
          onOpenChange={setFormatOpen}
          name={label}
          onConfirm={onFormatCloudComputer}
        />
      )}
      <CloudImageUpdateDialog
        open={imageUpdateOpen}
        name={label}
        version={imageOffer}
        onOpenChange={setImageUpdateOpen}
        onConfirm={async () => {
          setImageUpdateOpen(false);
          await runUpgrade(imageOffer, "image");
        }}
      />
      <ComputerUpgradeConfirmDialog
        open={upgradeConfirmOpen}
        onOpenChange={setUpgradeConfirmOpen}
        computerName={label}
        currentVersion={currentVersion}
        targetVersion={runtimeOffer}
        onConfirm={async () => {
          setUpgradeConfirmOpen(false);
          await runUpgrade(runtimeOffer, "runtime");
        }}
      />
      {onDeleteComputer && (
        <ConfirmDialog
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

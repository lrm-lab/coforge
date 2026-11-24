import { useEffect, useState } from "react";
import { ChevronRight, RefreshCw01 as RotateCw, Terminal } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { humanLabel } from "#src/lib/human-label";
import { m } from "#src/paraglide/messages";
import { AgentCreateDialog } from "#src/features/agents/agent-create-dialog";
import type { CreateAgentInput } from "#src/features/agents/agent.schemas";
import type { RuntimeCatalog } from "#src/features/agents/agent-runtime-fields";
import type { AgentControlExecute } from "#src/features/agents/agent-runtime-controls";
import type { AgentWorkspaceScanSnapshot } from "./agent-workspace-scan.query";
import { ComputerDetailAgentRoster } from "./computer-detail-agent-roster";
import { ComputerDetailHeader } from "./computer-detail-header";
import { ComputerDetailHero } from "./computer-detail-hero";
import { ComputerDetailMenu } from "./computer-detail-menu";
import { ComputerDetailStats } from "./computer-detail-stats";
import { ComputerDetailNameBand } from "./computer-detail-title";
import {
  RESTART_MAX_POLLS,
  RESTART_POLL_INTERVAL_MS,
  type ComputerDetailView,
  type RuntimeRescanResult,
} from "./computer-detail-view";
import { ComputerDetailWorkspaceInventory } from "./computer-detail-workspace-inventory";
import { computerLabel } from "./computer-identity";
import { activeRefusal, ComputerRefusalAlert } from "./computer-refusal";
import { computerRestartBusy } from "./computer-restart-run";
import { ComputerRuntimeList } from "./computer-runtimes";
import { nextProgressDeadline, runtimeUpgradePresentation } from "./computer-upgrade-progress-view";
import { CloudImageUpdateDialog, ComputerUpgradeConfirmDialog } from "./computer-upgrade-slot";
import type { ComputerRestartStatus, ComputerUpgradeStatus } from "./computer.schemas";
import { FormatCloudComputerDialog } from "./format-cloud-computer-dialog";
import { runtimeDetectionStatus, runtimeRescanNotice } from "./runtime-rescan-notice";
import { TerminalCommand } from "./terminal-command";
import { useComputerDetailLifecycle } from "./use-computer-detail-lifecycle";

export { RESTART_MAX_POLLS, RESTART_POLL_INTERVAL_MS, type ComputerDetailView };

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
  agentWorkspaceScan?: AgentWorkspaceScanSnapshot | null;
  onScanAgentWorkspaces?: () => Promise<void>;
  onDeleteAgentWorkspace?: (agentId: string) => Promise<{ status: string }>;
  onRemoveComputer?: () => Promise<void>;
  onDeleteComputer?: () => Promise<void>;
  onFormatCloudComputer?: (confirmName: string) => Promise<void>;
  onCreateAgent?: (input: CreateAgentInput) => Promise<{ startPublished: boolean }>;
  onLoadRuntimeCatalog?: (computerId: string) => Promise<RuntimeCatalog[]>;
  onRescanRuntimes?: () => Promise<RuntimeRescanResult>;
  onSelectAgent?: (agentId: string) => void;
  onExecuteAgentControl?: AgentControlExecute;
  latestComputerVersion?: string | null;
  restartPollIntervalMs?: number;
  restartMaxPolls?: number;
}) {
  const [workspaceScanStatus, setWorkspaceScanStatus] = useState<"idle" | "scanning" | "error">(
    "idle",
  );
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  const [formatOpen, setFormatOpen] = useState(false);
  const [imageUpdateOpen, setImageUpdateOpen] = useState(false);
  const [upgradeConfirmOpen, setUpgradeConfirmOpen] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [rescanResult, setRescanResult] = useState<RuntimeRescanResult | undefined>(undefined);
  const rescan = async () => {
    if (!onRescanRuntimes || rescanning) return;
    setRescanning(true);
    setRescanResult(undefined);
    try {
      setRescanResult(await onRescanRuntimes());
    } catch {
      setRescanResult({ status: "timeout" });
    } finally {
      setRescanning(false);
    }
  };
  const rescanNotice = runtimeRescanNotice(rescanResult);
  const canRescan = Boolean(onRescanRuntimes && computer.online);
  const hasRuntimes = computer.runtimes.length > 0;
  const detectionStatus = runtimeDetectionStatus({
    hasRuntimes,
    runtimeDetecting: computer.runtimeDetecting,
    rescanning,
    rescanButtonVisible: canRescan,
  });
  const workspaceSlug = useWorkspaceSlug();
  const label = computerLabel(computer);
  const creatorName = computer.creator ? humanLabel(computer.creator) : "";
  const {
    isCloud,
    currentVersion,
    currentImageVersion,
    runtimeSlot,
    imageSlot,
    runtimeOffer,
    imageOffer,
    upgrading,
    restartState,
    runUpgrade,
    runRestart,
  } = useComputerDetailLifecycle({
    computerId: computer.id,
    computerName: label,
    workspaceSlug,
    kind: computer.kind,
    ownedByCurrentUser: computer.ownedByCurrentUser,
    computerVersion: computer.computerVersion,
    imageVersion: computer.imageVersion,
    imageUpdate: computer.imageUpdate,
    upgrade: computer.upgrade,
    upgradeProgressRequestId: computer.upgradeProgressRequestId,
    latestComputerVersion,
    onUpgrade,
    onRestart,
    onReadRestartStatus,
    restartPollIntervalMs,
    restartMaxPolls,
  });
  const canUpgrade = Boolean(onUpgrade) && computer.ownedByCurrentUser;
  const visibleRuntimeSlot = computer.ownedByCurrentUser ? runtimeSlot : null;
  const [upgradeClockNow, setUpgradeClockNow] = useState(() => Date.now());
  const progressDeadline =
    visibleRuntimeSlot?.state === "progress"
      ? nextProgressDeadline(visibleRuntimeSlot.progress, upgradeClockNow)
      : undefined;
  useEffect(() => {
    if (progressDeadline === undefined) return;
    const delay = Math.max(0, progressDeadline - Date.now()) + 16;
    const timer = setTimeout(() => setUpgradeClockNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [progressDeadline]);
  const runtimePresentation = runtimeUpgradePresentation({
    slot: visibleRuntimeSlot,
    canUpgrade,
    online: computer.online,
    upgradeInFlight: upgrading,
    now: upgradeClockNow,
  });
  const heroUpgrade = runtimePresentation.headerAction
    ? {
        kind: runtimePresentation.headerAction.kind,
        label:
          runtimePresentation.headerAction.kind === "upgrading"
            ? m.computer_upgrade_in_progress()
            : runtimePresentation.headerAction.kind === "retry"
              ? m.computer_upgrade_retry_action()
              : m.computer_upgrade(),
        disabled: runtimePresentation.headerAction.disabled,
        onPress: () => setUpgradeConfirmOpen(true),
      }
    : undefined;
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

  const refusal = activeRefusal(computer);

  const runtimesNode = (
    <>
      {hasRuntimes ? (
        <ComputerRuntimeList
          computer={computer}
          timeZone={timeZone}
          onSetRuntimePublic={onSetRuntimePublic}
        />
      ) : detectionStatus === "detecting_empty" ? (
        <p className="text-sm text-tertiary" role="status">
          {m.computer_runtime_detection_empty()}
        </p>
      ) : (
        <p className="text-sm text-tertiary">{m.computer_no_code_agents()}</p>
      )}
      {detectionStatus === "detecting_with_list" ? (
        <p className="mt-1 text-sm text-tertiary" role="status">
          {m.computer_runtime_detection_pending()}
        </p>
      ) : null}
      {detectionStatus === "rescanning_with_list" ? (
        <p className="mt-1 text-sm text-tertiary" role="status">
          {m.computer_runtime_detection_rescanning()}
        </p>
      ) : null}
      {!rescanning && rescanNotice.kind === "timeout" ? (
        <p className="mt-1 text-sm text-error-primary" role="alert">
          {m.computer_runtime_rescan_failed()}
        </p>
      ) : null}
      {!rescanning && rescanNotice.kind === "error" ? (
        <p className="mt-1 text-sm text-error-primary" role="alert">
          {rescanNotice.message
            ? m.computer_runtime_rescan_error({ message: rescanNotice.message })
            : m.computer_runtime_rescan_failed()}
        </p>
      ) : null}
      {canRescan ? (
        <Button
          type="button"
          size="xs"
          color="link-gray"
          iconLeading={RotateCw}
          isLoading={rescanning}
          showTextWhileLoading
          isDisabled={rescanning}
          className="mt-2"
          onPress={() => void rescan()}
        >
          {rescanning ? m.computer_runtime_rescanning() : m.computer_runtime_rescan()}
        </Button>
      ) : null}
    </>
  );

  return (
    <>
      <ComputerDetailHeader
        computer={computer}
        title={label}
        menu={
          <ComputerDetailMenu
            name={label}
            onFormat={onFormatCloudComputer ? () => setFormatOpen(true) : undefined}
            onRemove={onRemoveComputer}
            onDelete={onDeleteComputer}
          />
        }
      />

      <div className="@container min-h-0 flex-1 overflow-y-auto pb-8">
        <ComputerDetailHero
          computer={computer}
          label={label}
          showDesktop={isCloud && computer.ownedByCurrentUser}
          upgrade={heroUpgrade}
          restart={
            onRestart && (computer.ownedByCurrentUser || computer.canManageAgents)
              ? {
                  pending: restartState === "pending",
                  disabled: computerRestartBusy({ upgrading, restartState }),
                  onPress: runRestart,
                }
              : undefined
          }
        />

        {refusal ? (
          <div className="border-b border-secondary px-page py-4">
            <ComputerRefusalAlert refusal={refusal} computer={computer} timeZone={timeZone} />
          </div>
        ) : null}

        <ComputerDetailNameBand
          key={computer.id}
          computer={computer}
          label={label}
          onUpdateDisplayName={onUpdateDisplayName}
        />

        <ComputerDetailStats
          computer={computer}
          label={label}
          timeZone={timeZone}
          creatorName={creatorName}
          isCloud={isCloud}
          currentVersion={currentVersion}
          currentImageVersion={currentImageVersion}
          isLatestVersion={Boolean(
            latestComputerVersion &&
            !runtimeOffer &&
            !runtimePresentation.versionNotice &&
            computer.online,
          )}
          versionNotice={runtimePresentation.versionNotice}
          showRecoveryAdvice={
            runtimePresentation.headerAction !== undefined &&
            runtimePresentation.headerAction.kind !== "upgrading"
          }
          imageSlot={computer.ownedByCurrentUser ? imageSlot : null}
          canUpgrade={canUpgrade}
          upgradeInFlight={upgrading}
          onImageUpgrade={() => setImageUpdateOpen(true)}
          runtimes={runtimesNode}
        />

        <div className="border-b border-secondary px-page py-4">
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
        </div>

        <div className="border-b border-secondary px-page py-4">
          <ComputerDetailWorkspaceInventory
            snapshot={onScanAgentWorkspaces ? agentWorkspaceScan : null}
            status={workspaceScanStatus}
            canScan={Boolean(onScanAgentWorkspaces)}
            onScan={() => void scanWorkspaces()}
            canDelete={Boolean(onDeleteAgentWorkspace)}
            timeZone={timeZone}
            onDelete={async (agentId) => {
              if (!onDeleteAgentWorkspace) return;
              const result = await onDeleteAgentWorkspace(agentId);
              if (result.status !== "ok" && result.status !== "missing")
                throw new Error("Workspace could not be deleted");
              await scanWorkspaces();
            }}
          />
        </div>

        {computer.ownedByCurrentUser ? (
          <details className="group border-b border-secondary px-page">
            <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2.5 py-3 text-sm font-medium text-secondary transition-colors outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-brand [&::-webkit-details-marker]:hidden">
              <Terminal aria-hidden="true" className="size-4 text-fg-quaternary" />
              <span className="flex-1">{m.computer_troubleshoot_terminal()}</span>
              <ChevronRight
                aria-hidden="true"
                className="size-4 text-fg-quaternary transition-transform duration-(--duration-sm) ease-in-out group-open:rotate-90 rtl:rotate-180 rtl:group-open:rotate-90 motion-reduce:transition-none"
              />
            </summary>
            <div className="space-y-2 pb-4">
              <p className="text-sm text-tertiary">{m.computer_verify_terminal_description()}</p>
              <TerminalCommand command="coforge-computer status" />
              <TerminalCommand command="coforge-computer logs" />
              <p className="pt-2 text-sm text-tertiary">{m.computer_restart_from_terminal()}</p>
              <TerminalCommand command={`coforge-computer restart --workspace ${workspaceSlug}`} />
            </div>
          </details>
        ) : null}
      </div>

      {onFormatCloudComputer ? (
        <FormatCloudComputerDialog
          open={formatOpen}
          onOpenChange={setFormatOpen}
          name={label}
          onConfirm={onFormatCloudComputer}
        />
      ) : null}
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
      {onCreateAgent && onLoadRuntimeCatalog ? (
        <AgentCreateDialog
          open={createAgentOpen}
          onOpenChange={setCreateAgentOpen}
          computers={[
            {
              id: computer.id,
              kind: computer.kind,
              name: computer.name,
              displayName: computer.displayName,
              online: computer.online,
              platform: computer.platform,
              ownedByCurrentUser: computer.ownedByCurrentUser,
              canManageAgents: computer.canManageAgents,
              runtimeAuth: computer.runtimeAuth,
              runtimes: computer.runtimes.map((runtime) => ({
                provider: runtime.provider,
                unavailableCode: runtime.unavailableCode,
                diagnostic: runtime.diagnostic,
              })),
            },
          ]}
          defaults={{ computerId: computer.id }}
          computerLocked
          onCreate={onCreateAgent}
          onLoadRuntimeCatalog={onLoadRuntimeCatalog}
        />
      ) : null}
    </>
  );
}

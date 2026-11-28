import { useEffect, useState } from "react";
import { RefreshCw01 as RotateCw } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { AgentCreateDialog } from "#src/features/agents/agent-create-dialog";
import type { AgentControlExecute } from "#src/features/agents/agent-runtime-controls";
import type { BatchRuntimeSaveResult } from "#src/features/agents/batch-agent-runtime-config-dialog";
import type { RuntimeCatalog } from "#src/features/agents/agent-runtime-fields";
import type {
  BatchUpdateAgentRuntimeConfigClientInput,
  CreateAgentInput,
} from "#src/features/agents/agent.schemas";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { humanLabel, UNNAMED_PERSON_NAME } from "#src/lib/human-label";
import { m } from "#src/paraglide/messages";
import type { AgentWorkspaceScanSnapshot } from "./agent-workspace-scan.query";
import { ComputerDetailAdvanced } from "./computer-detail-advanced";
import { ComputerDetailAgentRoster } from "./computer-detail-agent-roster";
import { ComputerDetailHeader } from "./computer-detail-header";
import { ComputerDetailHero } from "./computer-detail-hero";
import { ComputerDetailMenu } from "./computer-detail-menu";
import { ComputerDetailStats } from "./computer-detail-stats";
import {
  RESTART_MAX_POLLS,
  RESTART_POLL_INTERVAL_MS,
  type ComputerDetailView,
} from "./computer-detail-view";
import { ComputerDetailWorkspaceInventory } from "./computer-detail-workspace-inventory";
import { computerLabel } from "./computer-identity";
import { activeRefusal, ComputerRefusalAlert } from "./computer-refusal";
import { computerRestartBusy } from "./computer-restart-run";
import { ComputerRuntimeList } from "./computer-runtimes";
import {
  imageUpgradePresentation,
  nextProgressDeadline,
  resolveHeroUpgradeAction,
  runtimeUpgradePresentation,
} from "./computer-upgrade-progress-view";
import { CloudImageUpdateDialog, ComputerUpgradeConfirmDialog } from "./computer-upgrade-slot";
import type { ComputerRestartStatus, ComputerUpgradeStatus } from "./computer.schemas";
import { FormatCloudComputerDialog } from "./format-cloud-computer-dialog";
import { publicRuntimesHint } from "./public-runtimes-hint";
import type { RuntimeCatalogRefreshResult } from "./runtime-catalog-refresh-poll";
import { RuntimeRescanFeedback } from "./runtime-rescan-feedback";
import { runtimeDetectionStatus, runtimeRescanNotice } from "./runtime-rescan-notice";
import { ComputerTerminalSection } from "./terminal/computer-terminal-section";
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
  onLoadBatchEnvironmentKeys,
  onBatchUpdateRuntimeConfig,
  onBatchRuntimeConfigSaved,
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
  onRescanRuntimes?: () => Promise<RuntimeCatalogRefreshResult>;
  onSelectAgent?: (agentId: string) => void;
  onExecuteAgentControl?: AgentControlExecute;
  onLoadBatchEnvironmentKeys?: (agentIds: string[]) => Promise<Record<string, string[]>>;
  onBatchUpdateRuntimeConfig?: (
    input: BatchUpdateAgentRuntimeConfigClientInput,
  ) => Promise<BatchRuntimeSaveResult>;
  onBatchRuntimeConfigSaved?: (result: BatchRuntimeSaveResult) => Promise<void> | void;
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
  const [rescanResult, setRescanResult] = useState<RuntimeCatalogRefreshResult | undefined>(
    undefined,
  );
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
  const rescanNotice = runtimeRescanNotice(rescanResult, computer.runtimeAuth);
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
  const resolvedCreator = computer.creator ? humanLabel(computer.creator) : "";
  const creatorName =
    resolvedCreator === UNNAMED_PERSON_NAME ? m.computer_detail_creator_unnamed() : resolvedCreator;
  const ownerPublicRuntimesHint = publicRuntimesHint(computer);
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
  const visibleImageSlot = isCloud && computer.ownedByCurrentUser ? imageSlot : null;
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
  const imagePresentation = imageUpgradePresentation({
    slot: visibleImageSlot,
    canUpgrade,
    online: computer.online,
    upgradeInFlight: upgrading,
  });
  const { heroTarget, heroAction, inlineImageAction } = resolveHeroUpgradeAction(
    runtimePresentation.headerAction,
    imagePresentation.headerAction,
  );
  const runtimeActionLabel = (kind: "upgrade" | "upgrading" | "retry") =>
    kind === "upgrading"
      ? m.computer_upgrade_in_progress()
      : kind === "retry"
        ? m.computer_upgrade_retry_action()
        : m.computer_upgrade();
  const imageActionLabel = (kind: "upgrade" | "upgrading" | "retry") =>
    kind === "upgrading"
      ? m.computer_cloud_image_update_in_progress()
      : kind === "retry"
        ? m.computer_cloud_image_update_retry()
        : m.computer_cloud_image_update_button();
  const heroUpgrade = heroAction
    ? {
        kind: heroAction.kind,
        label:
          heroTarget === "image"
            ? imageActionLabel(heroAction.kind)
            : runtimeActionLabel(heroAction.kind),
        disabled: heroAction.disabled,
        onPress: () =>
          heroTarget === "image" ? setImageUpdateOpen(true) : setUpgradeConfirmOpen(true),
      }
    : undefined;
  const inlineImageUpgrade = inlineImageAction
    ? {
        kind: inlineImageAction.kind,
        label: imageActionLabel(inlineImageAction.kind),
        disabled: inlineImageAction.disabled,
        onPress: () => setImageUpdateOpen(true),
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
  const isLatestVersion = Boolean(
    currentVersion &&
    latestComputerVersion &&
    !runtimeOffer &&
    !runtimePresentation.versionNotice &&
    computer.online,
  );
  const restartAction =
    onRestart && (computer.ownedByCurrentUser || computer.canManageAgents) && computer.online
      ? {
          pending: restartState === "pending",
          disabled: computerRestartBusy({ upgrading, restartState }),
          onPress: runRestart,
        }
      : undefined;
  const autoOpenAdvanced =
    !computer.online ||
    runtimePresentation.versionNotice?.kind === "issue" ||
    imagePresentation.versionNotice?.kind === "issue";

  const runtimesAction = canRescan ? (
    <Button
      type="button"
      size="xs"
      color="link-gray"
      iconLeading={RotateCw}
      isLoading={rescanning}
      showTextWhileLoading
      isDisabled={rescanning}
      onPress={() => void rescan()}
    >
      {rescanning ? m.computer_runtime_rescanning() : m.computer_runtime_rescan()}
    </Button>
  ) : undefined;

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
      {ownerPublicRuntimesHint ? (
        <p className="mt-2 text-xs text-tertiary wrap-anywhere">{ownerPublicRuntimesHint}</p>
      ) : null}
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
      {!rescanning ? <RuntimeRescanFeedback notice={rescanNotice} /> : null}
    </>
  );

  return (
    <>
      <ComputerDetailHeader
        computer={computer}
        title={label}
        onUpdateDisplayName={onUpdateDisplayName}
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
          isCloud={isCloud}
          currentVersion={currentVersion}
          isLatestVersion={isLatestVersion}
          showDesktop={isCloud && computer.ownedByCurrentUser}
          showOfflineHint={!computer.online && !refusal}
          canTroubleshoot={computer.ownedByCurrentUser}
          upgrade={heroUpgrade}
          restart={restartAction}
        />

        {refusal ? (
          <div className="border-b border-secondary px-page py-4">
            <ComputerRefusalAlert refusal={refusal} computer={computer} timeZone={timeZone} />
          </div>
        ) : null}

        <div className="border-b border-secondary px-page py-4 last:border-b-0">
          <ComputerDetailAgentRoster
            computerId={computer.id}
            runtimes={computer.runtimes}
            agents={computer.agents}
            onCreateAgent={
              onCreateAgent && onLoadRuntimeCatalog ? () => setCreateAgentOpen(true) : undefined
            }
            onSelectAgent={onSelectAgent}
            onExecute={onExecuteAgentControl}
            onLoadRuntimeCatalog={onLoadRuntimeCatalog}
            onLoadBatchEnvironmentKeys={onLoadBatchEnvironmentKeys}
            onBatchUpdateRuntimeConfig={onBatchUpdateRuntimeConfig}
            onBatchRuntimeConfigSaved={onBatchRuntimeConfigSaved}
            canFullReset={computer.canManageAgents}
            computerOnline={computer.online}
            computerName={label}
          />
        </div>

        <ComputerDetailStats
          computer={computer}
          timeZone={timeZone}
          creatorName={creatorName}
          isCloud={isCloud}
          currentVersion={currentVersion}
          currentImageVersion={currentImageVersion}
          isLatestVersion={isLatestVersion}
          versionNotice={runtimePresentation.versionNotice}
          showRecoveryAdvice={
            runtimePresentation.headerAction !== undefined &&
            runtimePresentation.headerAction.kind !== "upgrading"
          }
          imageNotice={imagePresentation.versionNotice}
          imageAction={inlineImageUpgrade}
          canUpgrade={canUpgrade}
          upgradeInFlight={upgrading}
          runtimesAction={runtimesAction}
          runtimes={runtimesNode}
        />

        {computer.ownedByCurrentUser ? (
          <ComputerTerminalSection
            computerId={computer.id}
            computerName={label}
            computerOnline={computer.online}
            initialEnabled={computer.terminalEnabled ?? false}
            platform={computer.platform ?? null}
          />
        ) : null}

        <ComputerDetailAdvanced
          key={computer.id}
          autoOpen={autoOpenAdvanced}
          workspaceSlug={workspaceSlug}
          showTerminal={computer.ownedByCurrentUser}
          workspaceInventory={
            onScanAgentWorkspaces ? (
              <ComputerDetailWorkspaceInventory
                snapshot={agentWorkspaceScan}
                status={workspaceScanStatus}
                canScan
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
            ) : undefined
          }
        />
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
        currentVersion={currentImageVersion}
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
              creator: computer.creator,
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

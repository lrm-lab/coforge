import { Link } from "@tanstack/react-router";
import { ArrowUp, DotsHorizontal, Monitor01, RefreshCw01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { ProgressBarBase } from "#src/components/base/progress-indicators/progress-indicators";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { StatusDot } from "#src/components/ui/status-dot";
import { AgentDisplayAvatar } from "#src/features/agents/agent-display-avatar";
import { runtimeProviderLabel } from "#src/features/agents/runtime-provider-display";
import { RuntimeProviderMark } from "#src/features/agents/runtime-provider-mark";
import { useLiveAgentDisplay } from "#src/features/agents/workspace-agents-realtime";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { humanLabel } from "#src/lib/human-label";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import {
  availableUpdateVersion,
  computerKind,
  computerLabel,
  computerListUpdateVersion,
  operatingSystemLabel,
} from "./computer-identity";
import { isMachineDiskLow, machineUsageLabel, machineUsedPercent } from "./computer-machine-status";
import {
  computerRuntimeMeter,
  splitComputerRuntimes,
  type ComputerOverviewItem,
} from "./computer-overview-model";
import { activeRefusal, refusalLabel } from "./computer-refusal";
import { ComputerTile } from "./computer-tile";
import { USAGE_LEVEL_CLASS } from "./usage-level";

export type ComputerOverviewRowActions = {
  onSelect: (computer: ComputerOverviewItem) => void;
  onOpenDesktop?: (computer: ComputerOverviewItem) => void;
  onUpgrade?: (computer: ComputerOverviewItem, targetVersion: string) => void;
  onRestart?: (computer: ComputerOverviewItem) => void;
};

export function ComputerCardAgentChip({
  agent,
  avatarClassName,
  triggerClassName,
}: {
  agent: ComputerOverviewItem["agents"][number];
  avatarClassName?: string;
  triggerClassName?: string;
}) {
  const display = useLiveAgentDisplay(agent.id) ?? agent.display;
  return (
    <Tooltip title={agent.displayName}>
      <TooltipTrigger
        className={cn(
          "relative z-10 inline-flex shrink-0 rounded-full focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring",
          triggerClassName,
        )}
      >
        <AgentDisplayAvatar
          agentId={agent.id}
          name={agent.displayName}
          src={agent.avatarUrl}
          display={display}
          size="xs"
          className={avatarClassName}
        />
      </TooltipTrigger>
    </Tooltip>
  );
}

export function ComputerOverviewActionMenu({
  computer,
  updateOffer,
  upgrading,
  restarting,
  canOpenDesktop,
  actions,
}: {
  computer: ComputerOverviewItem;
  updateOffer?: string;
  upgrading: boolean;
  restarting: boolean;
  canOpenDesktop: boolean;
  actions: ComputerOverviewRowActions;
}) {
  const upgradeFailed = computer.ownedByCurrentUser && computer.upgrade?.status === "failed";
  const canUpgrade =
    computer.ownedByCurrentUser && Boolean(updateOffer) && !upgrading && Boolean(actions.onUpgrade);
  const canRestart =
    (computer.ownedByCurrentUser || Boolean(computer.canManageAgents)) &&
    Boolean(actions.onRestart);

  return (
    <Dropdown.Root>
      <ButtonUtility
        icon={DotsHorizontal}
        size="xs"
        color="tertiary"
        aria-label={m.computer_more_actions()}
        className="relative z-10 shrink-0"
      />
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label={m.computer_more_actions()}>
          <Dropdown.Item
            id="details"
            label={m.computer_upgrade_open_details()}
            onAction={() => actions.onSelect(computer)}
          />
          {canOpenDesktop && actions.onOpenDesktop ? (
            <Dropdown.Item
              id="desktop"
              icon={Monitor01}
              label={m.computer_open_desktop()}
              onAction={() => actions.onOpenDesktop?.(computer)}
            />
          ) : null}
          {canUpgrade && updateOffer ? (
            <Dropdown.Item
              id="upgrade"
              icon={ArrowUp}
              isDisabled={!computer.online}
              label={upgradeFailed ? m.computer_upgrade_retry() : m.computer_upgrade()}
              onAction={() => actions.onUpgrade?.(computer, updateOffer)}
            />
          ) : null}
          {canRestart ? (
            <Dropdown.Item
              id="restart"
              icon={RefreshCw01}
              isDisabled={!computer.online || upgrading || restarting}
              label={restarting ? m.computer_restart_requesting() : m.computer_restart_action()}
              onAction={() => actions.onRestart?.(computer)}
            />
          ) : null}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

export function ComputerCard({
  computer,
  workspaceSlug,
  selected,
  latestVersion,
  upgrading,
  restarting,
  canOpenDesktop,
  actions,
}: {
  computer: ComputerOverviewItem;
  workspaceSlug: string;
  selected: boolean;
  latestVersion: string | null | undefined;
  upgrading: boolean;
  restarting: boolean;
  canOpenDesktop: boolean;
  actions: ComputerOverviewRowActions;
}) {
  const label = computerLabel(computer);
  const os = operatingSystemLabel(computer);
  const refusal = activeRefusal(computer);
  const runtimeOffer = computer.ownedByCurrentUser
    ? availableUpdateVersion(computer, latestVersion)
    : undefined;
  const tileOffer = computerListUpdateVersion(computer, latestVersion);
  const upgradeFailed = computer.ownedByCurrentUser && computer.upgrade?.status === "failed";
  const creatorName = computer.creator ? humanLabel(computer.creator) : "";
  const { metered, other } = splitComputerRuntimes(computer);
  const disk = computer.machine?.disk ?? null;
  const memory = computer.machine?.memory ?? null;
  const diskPercent = disk ? machineUsedPercent(disk) : null;
  const memoryPercent = memory ? machineUsedPercent(memory) : null;
  const diskLow = disk ? isMachineDiskLow(disk) : false;
  const shownAgents = computer.agents.slice(0, 5);
  const extraAgents = computer.agents.length - shownAgents.length;
  const cloud = computerKind(computer.kind) === "cloud";

  const statusFooter = (() => {
    if (refusal) {
      return (
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-error-primary">
          <StatusDot tone="error" className="size-1.5" />
          <span className="truncate">{refusalLabel(refusal.reason)}</span>
        </span>
      );
    }
    if (upgrading) {
      const targetVersion =
        (computer.upgrade && "expectedVersion" in computer.upgrade
          ? computer.upgrade.expectedVersion
          : undefined) ?? runtimeOffer;
      return (
        <span className="min-w-0 truncate font-mono text-xs text-tertiary" dir="ltr">
          {targetVersion && computer.computerVersion
            ? `${computer.computerVersion} → ${targetVersion}`
            : (targetVersion ?? m.computer_upgrade_in_progress())}
        </span>
      );
    }
    if (upgradeFailed) {
      return (
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-error-primary">
          <StatusDot tone="error" className="size-1.5" />
          <span className="truncate">{m.computer_upgrade_failed_title_generic()}</span>
        </span>
      );
    }
    if (runtimeOffer) {
      return (
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-secondary">
          <StatusDot tone="online" className="size-1.5" />
          <span className="truncate">{m.computer_new_version({ version: runtimeOffer })}</span>
        </span>
      );
    }
    if (!computer.online) {
      return (
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-tertiary">
          <StatusDot tone="offline" className="size-1.5" />
          <span className="truncate">{m.computer_status_offline()}</span>
        </span>
      );
    }
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-tertiary">
        <StatusDot tone="online" className="size-1.5" />
        <span className="truncate">{m.computer_overview_latest_version()}</span>
      </span>
    );
  })();

  return (
    <li className="min-w-0">
      <div
        className={cn(
          "group relative flex h-full flex-col gap-3 rounded-xl border p-3.5 transition-colors",
          selected
            ? "border-brand bg-secondary"
            : "border-secondary bg-primary hover:border-primary hover:bg-primary_hover",
        )}
      >
        <div className="flex items-start gap-2.5">
          <Link
            to="/w/$workspaceSlug/computer/$computerId"
            params={{ workspaceSlug, computerId: computer.id }}
            aria-current={selected ? "page" : undefined}
            resetScroll={false}
            className="flex min-w-0 flex-1 items-start gap-2.5 rounded-lg outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:ring-2 focus-visible:ring-brand"
          >
            <ComputerTile
              computer={computer}
              online={computer.online}
              updateAvailableVersion={tileOffer}
              upgrading={upgrading}
              upgradeFailed={upgradeFailed}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-sm font-semibold text-primary">{label}</span>
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-tertiary">
                {os ? <span className="truncate">{os}</span> : null}
                {os && computer.computerVersion ? <span aria-hidden="true">·</span> : null}
                {computer.computerVersion ? (
                  <span dir="ltr" className="truncate font-mono">
                    {computer.computerVersion}
                  </span>
                ) : null}
              </span>
              {computer.creator ? (
                <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-tertiary">
                  <ActorAvatar
                    presence={false}
                    size="xs"
                    className="size-4"
                    name={creatorName}
                    src={computer.creator.avatarUrl}
                  />
                  <span className="truncate">{creatorName}</span>
                </span>
              ) : null}
            </span>
          </Link>

          <ComputerOverviewActionMenu
            computer={computer}
            updateOffer={runtimeOffer}
            upgrading={upgrading}
            restarting={restarting}
            canOpenDesktop={canOpenDesktop}
            actions={actions}
          />
        </div>

        <div className="flex min-h-6 items-center gap-1.5">
          {shownAgents.length > 0 ? (
            <>
              <div className="flex items-center gap-1">
                {shownAgents.map((agent) => (
                  <ComputerCardAgentChip key={agent.id} agent={agent} />
                ))}
              </div>
              {extraAgents > 0 ? (
                <span className="text-xs font-medium text-tertiary tabular-nums">
                  +{extraAgents}
                </span>
              ) : null}
              <span className="ms-auto shrink-0 text-xs text-tertiary tabular-nums">
                {m.computer_overview_agents_count({ count: computer.agents.length })}
              </span>
            </>
          ) : (
            <span className="text-xs text-quaternary">{m.computer_overview_no_agents()}</span>
          )}
        </div>

        {disk || memory ? (
          <div className="grid grid-cols-2 gap-3">
            <div className="min-w-0 space-y-1">
              <div className="flex items-baseline justify-between gap-1 text-xs">
                <span className="text-tertiary">{m.computer_disk()}</span>
                <span
                  className={cn(
                    "font-medium tabular-nums",
                    diskLow ? "text-warning-primary" : "text-secondary",
                  )}
                >
                  {diskPercent !== null ? `${diskPercent}%` : "—"}
                </span>
              </div>
              <ProgressBarBase
                value={diskPercent ?? 0}
                className="h-1.5"
                progressClassName={diskLow ? "bg-warning-solid" : "bg-fg-brand-primary"}
              />
              {disk ? (
                <p className="truncate text-xs text-quaternary tabular-nums">
                  {machineUsageLabel(disk, 1000)}
                </p>
              ) : null}
            </div>
            <div className="min-w-0 space-y-1">
              <div className="flex items-baseline justify-between gap-1 text-xs">
                <span className="text-tertiary">{m.computer_memory()}</span>
                <span className="font-medium text-secondary tabular-nums">
                  {memoryPercent !== null ? `${memoryPercent}%` : "—"}
                </span>
              </div>
              <ProgressBarBase
                value={memoryPercent ?? 0}
                className="h-1.5"
                progressClassName="bg-fg-brand-primary"
              />
              {memory ? (
                <p className="truncate text-xs text-quaternary tabular-nums">
                  {machineUsageLabel(memory, 1024)}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        {metered.length > 0 || other.length > 0 ? (
          <div className="space-y-1.5 border-t border-secondary pt-2.5">
            {metered.map((runtime) => {
              const meter = computerRuntimeMeter(computer, runtime.provider);
              return (
                <div key={runtime.id} className="flex items-center gap-2 text-xs">
                  <RuntimeProviderMark provider={runtime.provider} className="size-3.5 shrink-0" />
                  <span className="w-20 shrink-0 truncate text-secondary">
                    {runtimeProviderLabel(runtime.provider)}
                  </span>
                  {meter.kind === "meter" ? (
                    <>
                      <ProgressBarBase
                        value={meter.leftPercent}
                        className={cn("h-1.5 flex-1", USAGE_LEVEL_CLASS[meter.level].track)}
                        progressClassName={USAGE_LEVEL_CLASS[meter.level].fill}
                      />
                      <span
                        className={cn(
                          "w-8 shrink-0 text-right font-medium tabular-nums",
                          USAGE_LEVEL_CLASS[meter.level].value,
                        )}
                      >
                        {meter.leftPercent}%
                      </span>
                    </>
                  ) : meter.kind === "attention" ? (
                    <span className="ms-auto flex items-center gap-1 font-medium text-warning-primary">
                      <StatusDot tone="warning" className="size-1.5" />
                      {m.computer_overview_runtime_attention()}
                    </span>
                  ) : (
                    <span className="ms-auto text-quaternary">—</span>
                  )}
                </div>
              );
            })}
            {other.length > 0 ? (
              <div className="flex items-center gap-1.5 pt-0.5 text-xs text-tertiary">
                <span className="shrink-0 text-quaternary">
                  {m.computer_overview_other_runtimes()}
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  {other.slice(0, 4).map((runtime) => (
                    <span key={runtime.id} className="inline-flex items-center gap-1 truncate">
                      <RuntimeProviderMark
                        provider={runtime.provider}
                        className="size-3 shrink-0"
                      />
                      <span className="truncate">{runtimeProviderLabel(runtime.provider)}</span>
                    </span>
                  ))}
                  {other.length > 4 ? (
                    <span className="text-quaternary tabular-nums">+{other.length - 4}</span>
                  ) : null}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="mt-auto flex items-center justify-between gap-2 border-t border-secondary pt-2.5">
          {statusFooter}
          <div className="relative z-10 flex shrink-0 items-center gap-1.5">
            {cloud && canOpenDesktop && actions.onOpenDesktop ? (
              <Button
                type="button"
                size="xs"
                color="secondary"
                iconLeading={Monitor01}
                onPress={() => actions.onOpenDesktop?.(computer)}
              >
                {m.computer_overview_open_desktop_short()}
              </Button>
            ) : null}
            {upgrading || (runtimeOffer && actions.onUpgrade) ? (
              <Button
                type="button"
                size="xs"
                color="secondary"
                iconLeading={upgrading ? undefined : ArrowUp}
                isLoading={upgrading && !selected}
                showTextWhileLoading
                isDisabled={!computer.online || upgrading}
                onPress={() => {
                  if (runtimeOffer) actions.onUpgrade?.(computer, runtimeOffer);
                }}
              >
                {upgrading
                  ? m.computer_upgrade_in_progress()
                  : upgradeFailed
                    ? m.computer_upgrade_retry()
                    : m.computer_upgrade()}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
}

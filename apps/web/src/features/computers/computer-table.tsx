import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { Link } from "@tanstack/react-router";
import { ArrowUp, Monitor01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ProgressBarBase } from "#src/components/base/progress-indicators/progress-indicators";
import { StatusDot } from "#src/components/ui/status-dot";
import { runtimeProviderLabel } from "#src/features/agents/runtime-provider-display";
import { RuntimeProviderMark } from "#src/features/agents/runtime-provider-mark";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { humanLabel } from "#src/lib/human-label";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { ComputerOverviewActionMenu, type ComputerOverviewRowActions } from "./computer-card";
import { ComputerTableAgentsCell } from "./computer-table-agents";
import {
  availableUpdateVersion,
  computerKind,
  computerLabel,
  computerListUpdateVersion,
  operatingSystemLabel,
} from "./computer-identity";
import { isMachineDiskLow, machineUsedPercent } from "./computer-machine-status";
import {
  computerRuntimeMeter,
  splitComputerRuntimes,
  type ComputerOverviewItem,
  type ComputerOverviewSortBy,
} from "./computer-overview-model";
import { activeRefusal, refusalLabel } from "./computer-refusal";
import { ComputerTile } from "./computer-tile";
import { USAGE_LEVEL_CLASS } from "./usage-level";

export function ComputerTable({
  computers,
  workspaceSlug,
  selectedComputerId,
  meteredProviders,
  compact,
  sortBy,
  onSortByChange,
  latestVersions,
  upgradingIds,
  restartingIds,
  canOpenDesktop,
  actions,
}: {
  computers: readonly ComputerOverviewItem[];
  workspaceSlug: string;
  selectedComputerId?: string;
  meteredProviders: readonly RuntimeProvider[];
  compact: boolean;
  sortBy: ComputerOverviewSortBy;
  onSortByChange: (sortBy: ComputerOverviewSortBy) => void;
  latestVersions?: ReadonlyMap<string, string | null>;
  upgradingIds?: ReadonlySet<string>;
  restartingIds?: ReadonlySet<string>;
  canOpenDesktop: boolean;
  actions: ComputerOverviewRowActions;
}) {
  const shownProviders = meteredProviders.slice(0, 4);

  return (
    <div className="overflow-x-auto rounded-xl border border-secondary bg-primary">
      <div
        className={cn(
          "hidden items-center gap-3 border-b border-secondary bg-secondary_subtle px-3.5 py-2 text-xs font-medium text-tertiary md:grid",
          compact
            ? "grid-cols-[minmax(12rem,1.4fr)_5rem_minmax(7rem,0.9fr)_7.5rem]"
            : "grid-cols-[minmax(13rem,1.3fr)_7rem_4.5rem_4.5rem_minmax(14rem,1.8fr)_minmax(8.5rem,1fr)_10rem]",
        )}
      >
        <Button
          type="button"
          size="xs"
          color="link-gray"
          onPress={() => onSortByChange("name")}
          className={cn("justify-start text-xs", sortBy === "name" && "text-primary")}
        >
          {m.computer_overview_column_computer()}
        </Button>
        <span>{m.computer_overview_column_agents()}</span>
        {compact ? null : (
          <>
            <Button
              type="button"
              size="xs"
              color="link-gray"
              onPress={() => onSortByChange("disk")}
              className={cn("justify-start text-xs", sortBy === "disk" && "text-primary")}
            >
              {m.computer_disk()}
            </Button>
            <Button
              type="button"
              size="xs"
              color="link-gray"
              onPress={() => onSortByChange("memory")}
              className={cn("justify-start text-xs", sortBy === "memory" && "text-primary")}
            >
              {m.computer_memory()}
            </Button>
            <div className="flex min-w-0 items-center gap-3 overflow-hidden">
              {shownProviders.map((provider) => {
                const sortKey: ComputerOverviewSortBy = `runtime:${provider}`;
                return (
                  <Button
                    key={provider}
                    type="button"
                    size="xs"
                    color="link-gray"
                    onPress={() => onSortByChange(sortKey)}
                    className={cn(
                      "w-24 shrink-0 justify-start gap-1 text-xs",
                      sortBy === sortKey && "text-primary",
                    )}
                  >
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      <RuntimeProviderMark provider={provider} className="size-3.5 shrink-0" />
                      <span className="truncate">{runtimeProviderLabel(provider)}</span>
                    </span>
                  </Button>
                );
              })}
            </div>
          </>
        )}
        <span>{m.computer_overview_column_version()}</span>
        <span className="sr-only">{m.computer_more_actions()}</span>
      </div>

      <ul className="divide-y divide-secondary">
        {computers.map((computer) => {
          const selected = computer.id === selectedComputerId;
          const label = computerLabel(computer);
          const os = operatingSystemLabel(computer);
          const refusal = activeRefusal(computer);
          const latest = latestVersions?.get(computer.releaseChannel ?? "latest");
          const runtimeOffer = computer.ownedByCurrentUser
            ? availableUpdateVersion(computer, latest)
            : undefined;
          const tileOffer = computerListUpdateVersion(computer, latest);
          const upgrading = computer.ownedByCurrentUser && Boolean(upgradingIds?.has(computer.id));
          const restarting = Boolean(restartingIds?.has(computer.id));
          const upgradeFailed =
            computer.ownedByCurrentUser && computer.upgrade?.status === "failed";
          const creatorName = computer.creator ? humanLabel(computer.creator) : "";
          const disk = computer.machine?.disk ?? null;
          const memory = computer.machine?.memory ?? null;
          const diskPercent = disk ? machineUsedPercent(disk) : null;
          const memoryPercent = memory ? machineUsedPercent(memory) : null;
          const diskLow = disk ? isMachineDiskLow(disk) : false;
          const cloud = computerKind(computer.kind) === "cloud";
          const rowCanOpenDesktop = cloud && computer.ownedByCurrentUser && canOpenDesktop;
          const { other } = splitComputerRuntimes(computer);

          return (
            <li key={computer.id}>
              <div
                className={cn(
                  "group relative flex flex-col gap-2 px-3.5 py-2.5 transition-colors md:grid md:items-center md:gap-3",
                  compact
                    ? "md:grid-cols-[minmax(12rem,1.4fr)_5rem_minmax(7rem,0.9fr)_7.5rem]"
                    : "md:grid-cols-[minmax(13rem,1.3fr)_7rem_4.5rem_4.5rem_minmax(14rem,1.8fr)_minmax(8.5rem,1fr)_10rem]",
                  selected ? "bg-secondary" : "hover:bg-primary_hover",
                )}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <Link
                    to="/w/$workspaceSlug/computer/$computerId"
                    params={{ workspaceSlug, computerId: computer.id }}
                    aria-current={selected ? "page" : undefined}
                    resetScroll={false}
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg outline-none after:absolute after:inset-0 focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset"
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
                        {refusal ? (
                          <span className="truncate font-medium text-error-primary">
                            {refusalLabel(refusal.reason)}
                          </span>
                        ) : (
                          <>
                            {os ? <span className="truncate">{os}</span> : null}
                            {computer.creator ? (
                              <span className="inline-flex min-w-0 items-center gap-1">
                                {os ? <span aria-hidden="true">·</span> : null}
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
                          </>
                        )}
                      </span>
                    </span>
                  </Link>

                  <div className="relative z-10 flex shrink-0 items-center gap-1 md:hidden">
                    <ComputerOverviewActionMenu
                      computer={computer}
                      updateOffer={runtimeOffer}
                      upgrading={upgrading}
                      restarting={restarting}
                      canOpenDesktop={rowCanOpenDesktop}
                      actions={actions}
                    />
                  </div>
                </div>

                <ComputerTableAgentsCell agents={computer.agents} compact={compact} />

                {compact ? null : (
                  <>
                    <div className="hidden space-y-1 md:block">
                      {diskPercent !== null ? (
                        <>
                          <span
                            className={cn(
                              "block text-xs font-medium tabular-nums",
                              diskLow ? "text-warning-primary" : "text-secondary",
                            )}
                          >
                            {diskPercent}%
                          </span>
                          <ProgressBarBase
                            value={diskPercent}
                            className="h-1.5"
                            progressClassName={diskLow ? "bg-warning-solid" : "bg-fg-brand-primary"}
                          />
                        </>
                      ) : (
                        <span className="text-xs text-quaternary">—</span>
                      )}
                    </div>

                    <div className="hidden space-y-1 md:block">
                      {memoryPercent !== null ? (
                        <>
                          <span className="block text-xs font-medium text-secondary tabular-nums">
                            {memoryPercent}%
                          </span>
                          <ProgressBarBase
                            value={memoryPercent}
                            className="h-1.5"
                            progressClassName="bg-fg-brand-primary"
                          />
                        </>
                      ) : (
                        <span className="text-xs text-quaternary">—</span>
                      )}
                    </div>

                    <div className="hidden min-w-0 items-center gap-3 overflow-hidden md:flex">
                      {shownProviders.map((provider) => {
                        const installed = computer.runtimes.some(
                          (runtime) => runtime.provider === provider && !runtime.unavailableCode,
                        );
                        if (!installed) {
                          return (
                            <span key={provider} className="w-24 shrink-0 text-xs text-quaternary">
                              —
                            </span>
                          );
                        }
                        const meter = computerRuntimeMeter(computer, provider);
                        if (meter.kind === "meter") {
                          return (
                            <div key={provider} className="w-24 shrink-0 space-y-1">
                              <span
                                className={cn(
                                  "block text-xs font-medium tabular-nums",
                                  USAGE_LEVEL_CLASS[meter.level].value,
                                )}
                              >
                                {meter.leftPercent}%
                              </span>
                              <ProgressBarBase
                                value={meter.leftPercent}
                                className={cn("h-1.5", USAGE_LEVEL_CLASS[meter.level].track)}
                                progressClassName={USAGE_LEVEL_CLASS[meter.level].fill}
                              />
                            </div>
                          );
                        }
                        if (meter.kind === "attention") {
                          return (
                            <span
                              key={provider}
                              className="inline-flex w-24 shrink-0 items-center gap-1 text-xs font-medium text-warning-primary"
                            >
                              <StatusDot tone="warning" className="size-1.5" />
                              <span className="truncate">
                                {m.computer_overview_runtime_attention()}
                              </span>
                            </span>
                          );
                        }
                        return (
                          <span key={provider} className="w-24 shrink-0 text-xs text-quaternary">
                            —
                          </span>
                        );
                      })}
                      {other.length > 0 ? (
                        <span className="text-xs text-quaternary tabular-nums">
                          +{other.length}
                        </span>
                      ) : null}
                    </div>
                  </>
                )}

                <div className="flex flex-wrap items-center gap-2 ps-11 text-xs md:ps-0">
                  {computer.computerVersion ? (
                    <span dir="ltr" className="font-mono text-secondary">
                      {computer.computerVersion}
                    </span>
                  ) : null}
                  {upgrading ? (
                    <>
                      <span className="text-tertiary md:hidden">
                        {m.computer_upgrade_in_progress()}
                      </span>
                      {runtimeOffer ? (
                        <span dir="ltr" className="hidden font-mono text-tertiary md:inline">
                          → {runtimeOffer}
                        </span>
                      ) : null}
                    </>
                  ) : upgradeFailed ? (
                    <span className="inline-flex items-center gap-1 font-medium text-error-primary">
                      <StatusDot tone="error" className="size-1.5" />
                      {m.computer_upgrade_failed_title_generic()}
                    </span>
                  ) : runtimeOffer ? (
                    <span className="inline-flex items-center gap-1 text-secondary">
                      <StatusDot tone="online" className="size-1.5" />
                      <span dir="ltr" className="font-mono">
                        → {runtimeOffer}
                      </span>
                    </span>
                  ) : null}
                  <span className="flex items-center gap-2 text-quaternary md:hidden">
                    {diskPercent !== null ? (
                      <span className={cn(diskLow && "text-warning-primary")}>
                        {m.computer_overview_disk_short({ percent: diskPercent })}
                      </span>
                    ) : null}
                    {memoryPercent !== null ? (
                      <span>{m.computer_overview_memory_short({ percent: memoryPercent })}</span>
                    ) : null}
                    {computer.agents.length > 0 ? (
                      <span>
                        {m.computer_overview_agents_count({ count: computer.agents.length })}
                      </span>
                    ) : null}
                  </span>
                </div>

                <div className="relative z-10 hidden items-center justify-end gap-1.5 md:flex">
                  {rowCanOpenDesktop && actions.onOpenDesktop ? (
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
                  <ComputerOverviewActionMenu
                    computer={computer}
                    updateOffer={runtimeOffer}
                    upgrading={upgrading}
                    restarting={restarting}
                    canOpenDesktop={rowCanOpenDesktop}
                    actions={actions}
                  />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

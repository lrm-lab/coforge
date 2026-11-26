import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useHydrated, useRouter } from "@tanstack/react-router";
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { AlertCircle, Plus } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { PageHeader } from "#src/components/layout/page-header";
import { EmptyState } from "#src/components/ui/empty";
import { ComputersWireframe } from "#src/components/ui/empty-wireframes";
import { localLayoutStorage } from "#src/features/conversations/local-layout-storage";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { OPEN_OVERLAY_SELECTOR } from "#src/lib/open-overlay";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { BackToComputersContext, ComputerDetailPaneContext } from "./back-to-computers";
import { CloudDesktopOverlay } from "./cloud-desktop-overlay";
import { ComputerBatchUpgradeDialog } from "./computer-batch-upgrade-dialog";
import { ComputerCard } from "./computer-card";
import { computerKind, computerLabel } from "./computer-identity";
import { useComputersOverviewLayout } from "./computer-overview-layout";
import {
  batchUpgradeCandidates,
  computerSummaryCounts,
  filterComputers,
  groupComputers,
  isMeteredRuntime,
  sortComputers,
  visibleMeteredProviders,
  type ComputerOverviewGroupBy,
  type ComputerOverviewItem,
  type ComputerOverviewRuntimeFilter,
  type ComputerOverviewSortBy,
  type ComputerOverviewStatusFilter,
} from "./computer-overview-model";
import { ComputerOverviewToolbar } from "./computer-overview-toolbar";
import { ComputerTable } from "./computer-table";
import { ComputerUpgradeConfirmDialog } from "./computer-upgrade-slot";
import type { ComputerRestartStatus, ComputerUpgradeStatus } from "./computer.schemas";
import { useComputerOverviewActions } from "./use-computer-overview-actions";

export type ComputerListItem = ComputerOverviewItem;

function groupHeading(groupBy: ComputerOverviewGroupBy, key: string): string | null {
  if (groupBy === "none") return null;
  if (groupBy === "owner") {
    return key === "mine" ? m.computer_overview_group_mine() : m.computer_overview_group_others();
  }
  if (groupBy === "kind") {
    return key === "cloud" ? m.computer_overview_group_cloud() : m.computer_overview_group_local();
  }
  return key === "other" ? m.computer_overview_group_other() : key;
}

export function ComputerLayout({
  computers,
  selectedComputerId,
  onAdd,
  onUpgradeComputer,
  onRestartComputer,
  onReadRestartStatus,
  latestComputerVersions,
  upgradingComputerIds,
  children,
}: {
  computers: ComputerOverviewItem[];
  selectedComputerId?: string;
  onAdd: () => void;
  onUpgradeComputer?: (
    computerId: string,
    requestId: string,
    target?: "runtime" | "image",
  ) => Promise<ComputerUpgradeStatus>;
  onRestartComputer?: (computerId: string, requestId: string) => Promise<ComputerRestartStatus>;
  onReadRestartStatus?: (computerId: string, requestId: string) => Promise<ComputerRestartStatus>;
  latestComputerVersions?: ReadonlyMap<string, string | null>;
  upgradingComputerIds?: ReadonlySet<string>;
  children: ReactNode;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const router = useRouter();
  const hydrated = useHydrated();
  const desktop = useBreakpoint("md");
  const detailPanelRef = usePanelRef();
  const [layout, setLayout] = useComputersOverviewLayout();

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<ComputerOverviewStatusFilter>("all");
  const [runtime, setRuntime] = useState<ComputerOverviewRuntimeFilter>("all");
  const [groupBy, setGroupBy] = useState<ComputerOverviewGroupBy>("none");
  const [sortBy, setSortBy] = useState<ComputerOverviewSortBy>("attention");
  const [expanded, setExpanded] = useState(false);

  const splitOpen = Boolean(selectedComputerId) && !expanded;
  const splitLayout = useDefaultLayout({
    id: "coforge-computers",
    panelIds: hydrated && desktop && splitOpen ? ["overview", "detail"] : ["overview"],
    onlySaveAfterUserInteractions: true,
    storage: localLayoutStorage,
  });

  useEffect(() => {
    if (!selectedComputerId) setExpanded(false);
  }, [selectedComputerId]);

  const expandedOverlay = Boolean(selectedComputerId) && expanded;

  useHotkey(
    "Escape",
    () => {
      if (document.querySelector(OPEN_OVERLAY_SELECTOR) !== null) return;
      setExpanded(false);
    },
    { enabled: expandedOverlay, ignoreInputs: true, preventDefault: false },
  );

  const summary = useMemo(() => computerSummaryCounts(computers), [computers]);
  const batchCandidates = useMemo(
    () =>
      batchUpgradeCandidates(computers, {
        latestVersions: latestComputerVersions,
        upgradingIds: upgradingComputerIds,
      }),
    [computers, latestComputerVersions, upgradingComputerIds],
  );
  const meteredProviders = useMemo(() => visibleMeteredProviders(computers), [computers]);
  const hasOtherRuntime = useMemo(
    () => computers.some((computer) => computer.runtimes.some((item) => !isMeteredRuntime(item))),
    [computers],
  );
  const filteredComputers = useMemo(
    () => filterComputers(computers, { query, status, runtime }),
    [computers, query, status, runtime],
  );
  const sortedComputers = useMemo(
    () => sortComputers(filteredComputers, sortBy),
    [filteredComputers, sortBy],
  );
  const groups = useMemo(
    () => groupComputers(sortedComputers, groupBy),
    [sortedComputers, groupBy],
  );

  const overviewActions = useComputerOverviewActions({
    computers,
    workspaceSlug,
    batchCandidates,
    onUpgradeComputer,
    onRestartComputer,
    onReadRestartStatus,
  });

  const effectiveUpgradingIds = useMemo(() => {
    if (!overviewActions.requestingUpgradeIds.size) return upgradingComputerIds;
    const merged = new Set(upgradingComputerIds);
    for (const id of overviewActions.requestingUpgradeIds) merged.add(id);
    return merged;
  }, [upgradingComputerIds, overviewActions.requestingUpgradeIds]);

  const navigateToOverview = useCallback(() => {
    setExpanded(false);
    void router.navigate({
      to: "/w/$workspaceSlug/computers",
      params: { workspaceSlug },
    });
  }, [router, workspaceSlug]);

  const toggleExpand = useCallback(() => {
    setExpanded((value) => !value);
  }, []);

  const detailPaneControls = useMemo(
    () => ({
      expanded,
      onToggleExpand: toggleExpand,
      onClose: navigateToOverview,
    }),
    [expanded, toggleExpand, navigateToOverview],
  );

  const clearFilters = () => {
    setQuery("");
    setStatus("all");
    setRuntime("all");
  };

  const rowActions = useMemo(
    () => ({
      onSelect: (computer: ComputerOverviewItem) => {
        void router.navigate({
          to: "/w/$workspaceSlug/computer/$computerId",
          params: { workspaceSlug, computerId: computer.id },
        });
      },
      onOpenDesktop: overviewActions.canOpenDesktop ? overviewActions.handleOpenDesktop : undefined,
      onUpgrade: onUpgradeComputer
        ? (computer: ComputerOverviewItem, targetVersion: string) =>
            overviewActions.setUpgradePrompt({ computer, targetVersion })
        : undefined,
      onRestart: onRestartComputer ? overviewActions.handleRestart : undefined,
    }),
    [
      router,
      workspaceSlug,
      overviewActions.canOpenDesktop,
      overviewActions.handleOpenDesktop,
      overviewActions.setUpgradePrompt,
      overviewActions.handleRestart,
      onUpgradeComputer,
      onRestartComputer,
    ],
  );

  if (!computers.length) {
    return (
      <main className="flex h-full min-w-0">
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-primary">
          <PageHeader heading={m.computer_page_title()} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <NoComputers onAdd={onAdd} />
          </div>
        </section>
      </main>
    );
  }

  const desktopSplit = hydrated && desktop;
  const overviewHiddenOnMobile = Boolean(selectedComputerId);
  const hasFilters = Boolean(query.trim()) || status !== "all" || runtime !== "all";

  const overviewNav = (
    <nav
      aria-label={m.computer_connected_list()}
      inert={expandedOverlay}
      className={cn(
        "@container/overview min-w-0 flex-1 flex-col overflow-hidden bg-primary md:flex",
        overviewHiddenOnMobile ? "hidden" : "flex",
      )}
    >
      <PageHeader
        heading={m.computer_page_title()}
        meta={
          <span className="hidden items-center gap-2 truncate text-xs text-tertiary sm:inline-flex">
            <span className="truncate tabular-nums">
              {m.computer_overview_summary({
                total: summary.total,
                online: summary.online,
                agents: summary.agents,
              })}
            </span>
            {summary.attention > 0 ? (
              <span className="shrink-0 font-medium text-warning-primary tabular-nums">
                · {m.computer_overview_summary_attention({ count: summary.attention })}
              </span>
            ) : null}
          </span>
        }
      />

      <ComputerOverviewToolbar
        query={query}
        onQueryChange={setQuery}
        status={status}
        onStatusChange={setStatus}
        runtime={runtime}
        onRuntimeChange={setRuntime}
        runtimeOptions={meteredProviders}
        hasOtherRuntime={hasOtherRuntime}
        groupBy={groupBy}
        onGroupByChange={setGroupBy}
        sortBy={sortBy}
        onSortByChange={setSortBy}
        layout={layout}
        onLayoutChange={setLayout}
        batchUpgradeCount={batchCandidates.length}
        onBatchUpgrade={() => overviewActions.setBatchUpgradeOpen(true)}
        onAdd={onAdd}
        compact={splitOpen}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-page py-4">
        {summary.attention > 0 && status !== "attention" ? (
          <div className="mb-3 flex items-center">
            <Button
              type="button"
              size="xs"
              color="secondary-warning"
              iconLeading={AlertCircle}
              onPress={() => setStatus("attention")}
            >
              {summary.attention === 1
                ? m.computer_overview_attention_banner_one()
                : m.computer_overview_attention_banner({ count: summary.attention })}
            </Button>
          </div>
        ) : null}

        {sortedComputers.length === 0 ? (
          <EmptyState
            size="card"
            headingLevel={2}
            title={m.computer_overview_empty_filter_title()}
            description={m.computer_overview_empty_filter_description()}
            primaryAction={
              hasFilters ? (
                <Button type="button" size="sm" color="secondary" onPress={clearFilters}>
                  {m.computer_overview_clear_filters()}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="space-y-5">
            {groups.map((group) => {
              const heading = groupHeading(groupBy, group.key);
              return (
                <section key={group.key} className="space-y-2.5">
                  {heading ? (
                    <h2 className="flex items-center gap-2 text-xs font-semibold text-tertiary">
                      <span>{heading}</span>
                      <span className="font-normal text-quaternary tabular-nums">
                        {group.items.length}
                      </span>
                    </h2>
                  ) : null}

                  {layout === "card" ? (
                    <ul
                      className={cn(
                        "grid gap-3",
                        splitOpen
                          ? "grid-cols-1 @xl/overview:grid-cols-2"
                          : "grid-cols-1 @xl/overview:grid-cols-2 @4xl/overview:grid-cols-3",
                      )}
                    >
                      {group.items.map((computer) => (
                        <ComputerCard
                          key={computer.id}
                          computer={computer}
                          workspaceSlug={workspaceSlug}
                          selected={computer.id === selectedComputerId}
                          latestVersion={latestComputerVersions?.get(
                            computer.releaseChannel ?? "latest",
                          )}
                          upgrading={
                            computer.ownedByCurrentUser &&
                            Boolean(effectiveUpgradingIds?.has(computer.id))
                          }
                          restarting={overviewActions.restartingIds.has(computer.id)}
                          canOpenDesktop={
                            computer.ownedByCurrentUser &&
                            computerKind(computer.kind) === "cloud" &&
                            overviewActions.canOpenDesktop
                          }
                          actions={rowActions}
                        />
                      ))}
                    </ul>
                  ) : (
                    <ComputerTable
                      computers={group.items}
                      workspaceSlug={workspaceSlug}
                      selectedComputerId={selectedComputerId}
                      meteredProviders={meteredProviders}
                      compact={splitOpen}
                      sortBy={sortBy}
                      onSortByChange={setSortBy}
                      latestVersions={latestComputerVersions}
                      upgradingIds={effectiveUpgradingIds}
                      restartingIds={overviewActions.restartingIds}
                      canOpenDesktop={overviewActions.canOpenDesktop}
                      actions={rowActions}
                    />
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </nav>
  );

  const detailContent = (
    <ComputerDetailPaneContext value={detailPaneControls}>
      <BackToComputersContext value={navigateToOverview}>{children}</BackToComputersContext>
    </ComputerDetailPaneContext>
  );

  return (
    <main className="relative flex h-full min-w-0 bg-primary">
      {desktopSplit ? (
        <Group
          id="coforge-computers"
          orientation="horizontal"
          defaultLayout={splitLayout.defaultLayout}
          onLayoutChanged={splitLayout.onLayoutChanged}
          resizeTargetMinimumSize={{ coarse: 44, fine: 12 }}
          className="flex min-h-0 min-w-0 flex-1"
        >
          <Panel id="overview" minSize="35%" className="flex min-h-0 min-w-0 flex-col">
            {overviewNav}
          </Panel>
          {splitOpen ? (
            <>
              <Separator
                aria-label={m.computer_detail_resize()}
                onDoubleClick={() => detailPanelRef.current?.resize("43rem")}
                className="w-px shrink-0 bg-border-secondary outline-focus-ring transition-colors hover:bg-brand-solid focus-visible:bg-brand-solid focus-visible:outline-2 data-[separator=active]:bg-brand-solid"
              />
              <Panel
                id="detail"
                panelRef={detailPanelRef}
                defaultSize="43rem"
                minSize="26rem"
                maxSize="56rem"
                className="flex min-h-0 min-w-0 flex-col"
              >
                <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-primary">
                  {detailContent}
                </section>
              </Panel>
            </>
          ) : null}
        </Group>
      ) : (
        overviewNav
      )}

      {expandedOverlay ? (
        <div
          aria-hidden="true"
          onClick={toggleExpand}
          className="absolute inset-0 z-20 hidden bg-overlay/15 md:block"
        />
      ) : null}

      {selectedComputerId && (!desktopSplit || expanded) ? (
        <section
          className={cn(
            "flex min-w-0 flex-col overflow-hidden bg-primary",
            splitOpen
              ? "relative flex-1 md:w-[43rem] md:max-w-[65%] md:min-w-96 md:flex-none md:shrink-0 md:border-s md:border-secondary"
              : "flex-1 md:absolute md:inset-y-0 md:end-0 md:z-30 md:w-[calc(100%-8rem)] md:border-s md:border-secondary md:shadow-2xl",
          )}
        >
          {detailContent}
        </section>
      ) : null}

      {overviewActions.upgradePrompt ? (
        <ComputerUpgradeConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) overviewActions.setUpgradePrompt(null);
          }}
          computerName={computerLabel(overviewActions.upgradePrompt.computer)}
          currentVersion={overviewActions.upgradePrompt.computer.computerVersion}
          targetVersion={overviewActions.upgradePrompt.targetVersion}
          onConfirm={overviewActions.confirmSingleUpgrade}
        />
      ) : null}

      <ComputerBatchUpgradeDialog
        open={overviewActions.batchUpgradeOpen}
        onOpenChange={overviewActions.setBatchUpgradeOpen}
        candidates={batchCandidates}
        onConfirm={overviewActions.confirmBatchUpgrade}
      />

      {overviewActions.desktopOverlay ? (
        <CloudDesktopOverlay
          url={overviewActions.desktopOverlay.url}
          title={overviewActions.desktopOverlay.title}
          onClose={() => overviewActions.setDesktopOverlay(null)}
        />
      ) : null}
    </main>
  );
}

function NoComputers({ onAdd }: { onAdd: () => void }) {
  return (
    <EmptyState
      size="page"
      headingLevel={2}
      picture={<ComputersWireframe accent />}
      title={m.empty_computers_title()}
      description={m.empty_computers_description()}
      primaryAction={
        <Button iconLeading={Plus} onPress={onAdd}>
          {m.computer_add_title()}
        </Button>
      }
    />
  );
}

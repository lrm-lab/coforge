import { lazy, Suspense, useCallback, useLayoutEffect, useRef, useState } from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { useHydrated } from "@tanstack/react-router";
import { AnimatePresence } from "motion/react";
import { AlertCircle, UsersPlus } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { Tab, TabList, TabPanel, Tabs } from "#src/components/application/tabs/tabs";
import { Button } from "#src/components/base/buttons/button";
import { Select } from "#src/components/base/select/select";
import { PageBackButton } from "#src/components/layout/page-back-button";
import { PANE_HEADER_ATTR, PANE_SUBBAR_ATTR } from "#src/components/layout/pane-header";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { Skeleton } from "#src/components/ui/skeleton";
import {
  UNDERLINE_TAB_CLASS,
  UnderlineStripFrame,
} from "#src/components/ui/underline-filter-group";
import { CountBadge } from "#src/components/ui/unread-marker";
import { localLayoutStorage } from "#src/features/conversations/local-layout-storage";
import type { MemberDirectorySummary } from "#src/features/workspaces/workspaces.functions";
import { isWorkspaceAdminRole } from "#src/features/workspaces/workspace-roles";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import {
  animateFlipFromRect,
  cancelFlipAnimation,
  consumeSharedRect,
} from "#src/lib/shared-element-rect";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

import { useBusyAgentCount } from "./agent-status-floor";
import { MemberDialogs, type MemberDialog } from "./member-dialogs";
import { MembersSearchInput } from "./members-search-input";
import { memberAgentsQuery, memberPeopleQuery } from "./member-directory-queries";
import {
  AgentsTableView,
  AllMembersView,
  COMPACT_CARD_GRID_CLASS,
  CreateAgentSplitButton,
  HumansDirectoryView,
} from "./member-directory-views";
import type { AgentCreateKind } from "./new-agent-dialog";
import { LazyAgentProfilePanel, LazyPersonProfilePanel } from "./profile-panel/lazy-profile-panels";
import { useOpenAgentProfile } from "./profile-panel/open-agent-profile";
import type { AgentProfileTab } from "./profile-panel/profile-panel-search";
import { SwipeableProfileOverlay } from "./swipeable-profile-overlay";

const LazyWorkspaceAgentUsageView = lazy(() =>
  import("./workspace-agent-usage-view").then((mod) => ({ default: mod.WorkspaceAgentUsageView })),
);

function WorkingAgentsSummary() {
  const busyCount = useBusyAgentCount();
  return <span>{m.member_working_summary({ working: busyCount })}</span>;
}

export type MemberTab = "all" | "agent" | "human";
export type OwnerFilter = "all" | "mine";
export type AgentViewMode = "list" | "usage";

export function AgentsContent({
  summary,
  memberType,
  owner,
  agentView,
  onFiltersChange,
  profileAgentId,
  profilePersonId,
  agentTab,
  dialog,
  onDialogChange,
}: {
  summary: MemberDirectorySummary;
  memberType: MemberTab;
  owner: OwnerFilter;
  agentView: AgentViewMode;
  onFiltersChange: (filters: {
    memberType?: MemberTab;
    owner?: OwnerFilter;
    agentView?: AgentViewMode;
  }) => void;
  profileAgentId?: string;
  profilePersonId?: string;
  agentTab?: AgentProfileTab;
  dialog?: MemberDialog;
  onDialogChange: (dialog: MemberDialog | undefined) => void;
}) {
  const { setAgentProfileTab, closeAgentProfile } = useOpenAgentProfile();
  const [query, setQuery] = useState("");
  const [searchReset, setSearchReset] = useState(0);
  const [createAgentKind, setCreateAgentKind] = useState<AgentCreateKind | undefined>(undefined);
  const handleQueryChange = useCallback(
    (next: string) => setQuery((previous) => (previous === next ? previous : next)),
    [],
  );

  const isWorkspaceAdmin = isWorkspaceAdminRole(summary.actorRole);
  const canInviteMember = isWorkspaceAdmin;
  const canCreateAgent = canInviteMember;
  const onAllTab = memberType === "all";
  const onAgentTab = memberType === "agent";
  const onAgentUsage = onAgentTab && agentView === "usage";
  const onHumanTab = memberType === "human";
  const totalCount = summary.peopleCount + summary.agentCount;
  const effectiveOwner: OwnerFilter = onAgentTab ? owner : "all";
  const filtersActive = onAgentTab && owner === "mine";
  const searchLabel = onAllTab
    ? m.member_search_all()
    : onAgentTab
      ? m.member_search_agents()
      : m.member_search_humans();

  const agentPages = useInfiniteQuery({
    ...memberAgentsQuery(summary.workspaceId, { owner: effectiveOwner, query }),
    enabled: onAllTab || (onAgentTab && !onAgentUsage),
    placeholderData: keepPreviousData,
  });
  const peoplePages = useInfiniteQuery({
    ...memberPeopleQuery(summary.workspaceId, query),
    enabled: onAllTab || onHumanTab,
    placeholderData: keepPreviousData,
  });

  const listedAgents =
    onAllTab || onAgentTab ? (agentPages.data?.pages.flatMap((page) => page.items) ?? []) : [];
  const listedPeople =
    onAllTab || onHumanTab ? (peoplePages.data?.pages.flatMap((page) => page.items) ?? []) : [];

  const loadMoreAgents = () => {
    if (agentPages.hasNextPage && !agentPages.isFetchingNextPage) void agentPages.fetchNextPage();
  };
  const loadMorePeople = () => {
    if (peoplePages.hasNextPage && !peoplePages.isFetchingNextPage)
      void peoplePages.fetchNextPage();
  };

  const openCreateAgent = (kind?: AgentCreateKind) => {
    setCreateAgentKind(kind);
    onDialogChange("create-agent");
  };

  const clearSearch = () => {
    setSearchReset((count) => count + 1);
    setQuery("");
  };

  const profileOpen = Boolean(profileAgentId || profilePersonId);
  const hydrated = useHydrated();
  const desktop = useBreakpoint("md");
  const splitOpen = hydrated && desktop && profileOpen;
  const profile = profileAgentId ? (
    <LazyAgentProfilePanel
      agentId={profileAgentId}
      requestedTab={agentTab}
      onTabChange={setAgentProfileTab}
      onClose={closeAgentProfile}
      pageHeading={!splitOpen}
    />
  ) : profilePersonId ? (
    <LazyPersonProfilePanel
      key={profilePersonId}
      userId={profilePersonId}
      onClose={closeAgentProfile}
      pageHeading={!splitOpen}
    />
  ) : null;
  const membersLayout = useDefaultLayout({
    id: "coforge-members",
    panelIds: splitOpen ? ["main", "profile"] : ["main"],
    onlySaveAfterUserInteractions: true,
    storage: localLayoutStorage,
  });

  const activeError = onAgentUsage
    ? false
    : onAllTab
      ? peoplePages.isError && agentPages.isError && !peoplePages.data && !agentPages.data
      : onAgentTab
        ? agentPages.isError && !agentPages.data
        : peoplePages.isError && !peoplePages.data;

  const activePending = onAgentUsage
    ? false
    : onAllTab
      ? peoplePages.isPending && agentPages.isPending
      : onAgentTab
        ? agentPages.isPending
        : peoplePages.isPending;

  const ownerItems = [
    { id: "all", label: m.member_owner_filter_all() },
    { id: "mine", label: m.member_owner_filter_mine() },
  ];

  const directoryPane = (
    <Tabs
      selectedKey={memberType}
      onSelectionChange={(key) => {
        if (key === "all" || key === "agent" || key === "human") {
          onFiltersChange({ memberType: key });
        }
      }}
      className="@container/members flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <header
        {...PANE_HEADER_ATTR}
        className="flex h-pane-header shrink-0 items-center gap-3 border-b border-secondary px-page"
      >
        <PageBackButton />
        <h1 className="truncate text-lg font-semibold text-primary">
          {m.member_directory_title()}
        </h1>
        <p className="hidden min-w-0 items-center gap-3 truncate text-xs text-tertiary tabular-nums sm:flex">
          <WorkingAgentsSummary />
          <span>{m.member_total_summary({ count: totalCount })}</span>
        </p>
      </header>

      <div {...PANE_SUBBAR_ATTR} className="shrink-0 border-b border-secondary px-page">
        <UnderlineStripFrame
          activeKey={`${memberType}:${totalCount}:${summary.peopleCount}:${summary.agentCount}`}
          observe='[role="tab"]'
        >
          {(slidingVisible) => (
            <TabList
              aria-label={m.member_type_filter()}
              type="underline"
              size="sm"
              className="gap-4 before:hidden"
            >
              {(
                [
                  { id: "all", label: m.member_tab_all(), count: totalCount },
                  { id: "human", label: m.member_tab_humans(), count: summary.peopleCount },
                  { id: "agent", label: m.member_tab_agents(), count: summary.agentCount },
                ] as const
              ).map((tab) => (
                <Tab
                  key={tab.id}
                  id={tab.id}
                  className={({ isSelected }) =>
                    cn(
                      UNDERLINE_TAB_CLASS,
                      !slidingVisible && "aria-selected:after:border-fg-primary",
                      isSelected ? "text-primary" : "text-tertiary",
                    )
                  }
                >
                  {() => (
                    <>
                      <span>{tab.label}</span>
                      <CountBadge count={tab.count} size="sm" />
                    </>
                  )}
                </Tab>
              ))}
            </TabList>
          )}
        </UnderlineStripFrame>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2.5 px-page pt-3 pb-3">
        <MembersSearchInput
          label={searchLabel}
          resetSignal={searchReset}
          onQueryChange={handleQueryChange}
          className="min-w-[12rem] flex-1"
        />

        {onAgentTab && (summary.agentCount > 0 || onAgentUsage) && (
          <>
            <div
              role="group"
              aria-label={m.agent_view_mode_label()}
              className="inline-flex shrink-0 rounded-lg bg-secondary p-0.5 ring-1 ring-primary ring-inset"
            >
              {(["list", "usage"] as const).map((mode) => {
                const active = agentView === mode;
                return (
                  <AriaButton
                    key={mode}
                    aria-pressed={active}
                    onPress={() => onFiltersChange({ agentView: mode })}
                    className={cn(
                      "min-h-8 cursor-pointer rounded-md px-2.5 text-xs font-medium outline-none transition-colors data-focus-visible:ring-2 data-focus-visible:ring-brand",
                      active
                        ? "bg-primary font-semibold text-primary shadow-xs"
                        : "text-tertiary hover:text-primary",
                    )}
                  >
                    {mode === "list" ? m.agent_view_list() : m.agent_view_usage()}
                  </AriaButton>
                );
              })}
            </div>

            {(!onAgentUsage || isWorkspaceAdmin) && (
              <Select
                aria-label={m.member_owner_filter()}
                size="sm"
                items={ownerItems}
                selectedKey={owner}
                onSelectionChange={(key) => {
                  if (key === "all" || key === "mine") onFiltersChange({ owner: key });
                }}
                className="w-36 shrink-0"
              >
                {(item) => <Select.Item id={item.id} label={item.label} />}
              </Select>
            )}
          </>
        )}

        {!onAgentUsage && (canInviteMember || canCreateAgent) && (
          <div className="flex shrink-0 items-center gap-2">
            {canInviteMember && (
              <Button
                size="sm"
                color="secondary"
                iconLeading={UsersPlus}
                onPress={() => onDialogChange("invite")}
              >
                {m.member_invite_humans()}
              </Button>
            )}
            {canCreateAgent && <CreateAgentSplitButton onCreate={openCreateAgent} />}
          </div>
        )}
      </div>

      <TabPanel
        id={memberType}
        className="relative flex min-h-0 flex-1 flex-col overflow-y-auto px-page pt-2 pb-8"
      >
        {activeError ? (
          <EmptyState
            size="page"
            role="alert"
            picture={<EmptyIcon icon={AlertCircle} />}
            title={m.empty_members_load_failed_title()}
            description={m.empty_load_failed_safe()}
            primaryAction={
              <RetryButton
                size="page"
                isRetrying={peoplePages.isRefetching || agentPages.isRefetching}
                onPress={() => {
                  if (onAllTab || onHumanTab) void peoplePages.refetch();
                  if (onAllTab || onAgentTab) void agentPages.refetch();
                }}
              />
            }
          />
        ) : activePending ? (
          <div role="status" aria-label={m.agents_loading()} className={COMPACT_CARD_GRID_CLASS}>
            <Skeleton className="h-16 rounded-xl" />
            <Skeleton className="h-16 rounded-xl" />
            <Skeleton className="h-16 rounded-xl" />
            <Skeleton className="h-16 rounded-xl" />
          </div>
        ) : onAllTab ? (
          <AllMembersView
            people={listedPeople}
            agents={listedAgents}
            peopleCount={summary.peopleCount}
            agentCount={summary.agentCount}
            viewerId={summary.viewerId}
            profilePersonId={profilePersonId}
            profileAgentId={profileAgentId}
            query={query}
            canCreateAgent={canCreateAgent}
            isFetchingMorePeople={peoplePages.isFetchingNextPage}
            isFetchingMoreAgents={agentPages.isFetchingNextPage}
            onLoadMorePeople={loadMorePeople}
            onLoadMoreAgents={loadMoreAgents}
            onClearSearch={clearSearch}
            onCreateAgent={() => openCreateAgent(undefined)}
          />
        ) : onHumanTab ? (
          <HumansDirectoryView
            people={listedPeople}
            peopleCount={summary.peopleCount}
            viewerId={summary.viewerId}
            profilePersonId={profilePersonId}
            query={query}
            canInviteMember={canInviteMember}
            isFetchingMore={peoplePages.isFetchingNextPage}
            onLoadMore={loadMorePeople}
            onClearSearch={clearSearch}
            onInvite={() => onDialogChange("invite")}
          />
        ) : onAgentTab && agentView === "usage" ? (
          <Suspense
            fallback={
              <div className={COMPACT_CARD_GRID_CLASS}>
                <Skeleton className="h-24 rounded-xl" />
                <Skeleton className="h-24 rounded-xl" />
              </div>
            }
          >
            <LazyWorkspaceAgentUsageView
              workspaceId={summary.workspaceId}
              viewerId={summary.viewerId}
              owner={isWorkspaceAdmin ? owner : "all"}
              query={query}
              profileAgentId={profileAgentId}
              onClearFilters={() => {
                clearSearch();
                if (isWorkspaceAdmin && filtersActive) onFiltersChange({ owner: "all" });
              }}
            />
          </Suspense>
        ) : (
          <AgentsTableView
            agents={listedAgents}
            agentCount={summary.agentCount}
            profileAgentId={profileAgentId}
            query={query}
            filtersActive={filtersActive}
            canCreateAgent={canCreateAgent}
            isFetchingMore={agentPages.isFetchingNextPage}
            onLoadMore={loadMoreAgents}
            onClearFilters={() => {
              clearSearch();
              if (filtersActive) onFiltersChange({ owner: "all" });
            }}
            onCreateAgent={() => openCreateAgent(undefined)}
          />
        )}

        {((onAllTab || (onAgentTab && !onAgentUsage)) && agentPages.isFetchNextPageError) ||
        ((onHumanTab || onAllTab) && peoplePages.isFetchNextPageError) ? (
          <EmptyState
            size="row"
            role="alert"
            className="mt-4"
            title={m.empty_members_load_failed_title()}
            primaryAction={
              <RetryButton
                size="row"
                isRetrying={agentPages.isFetchingNextPage || peoplePages.isFetchingNextPage}
                onPress={() => {
                  if (agentPages.isFetchNextPageError) void agentPages.fetchNextPage();
                  if (peoplePages.isFetchNextPageError) void peoplePages.fetchNextPage();
                }}
              />
            }
          />
        ) : null}
      </TabPanel>
    </Tabs>
  );

  const reduced = usePrefersReducedMotion();
  const profileWrapRef = useRef<HTMLDivElement>(null);
  const profileKey = profileAgentId ?? profilePersonId ?? "";

  useLayoutEffect(() => {
    if (!splitOpen || !profileOpen || reduced || !profileWrapRef.current) return;
    const origin = consumeSharedRect("member-profile-origin");
    if (!origin) return;
    const node = profileWrapRef.current;
    node.style.animation = "none";
    const anim = animateFlipFromRect(node, origin, {
      duration: 280,
      mode: "box",
      includeRadius: true,
    });
    return () => {
      if (anim) cancelFlipAnimation(node);
      node.style.animation = "";
    };
  }, [profileKey, profileOpen, reduced, splitOpen]);

  return (
    <main className="relative flex h-full min-w-0 overflow-hidden bg-primary md:overflow-visible">
      {splitOpen ? (
        <Group
          key="split"
          id="members"
          orientation="horizontal"
          defaultLayout={membersLayout.defaultLayout}
          onLayoutChanged={membersLayout.onLayoutChanged}
          className="flex min-h-0 min-w-0 flex-1"
        >
          <Panel id="main" minSize="40" className="flex min-h-0 min-w-0 flex-col">
            {directoryPane}
          </Panel>
          <Separator
            aria-label={m.agent_profile_resize()}
            className="w-px shrink-0 bg-border-secondary transition-colors hover:bg-brand-solid data-[separator=active]:bg-brand-solid"
          />
          <Panel
            id="profile"
            defaultSize="35"
            minSize="25"
            maxSize="60"
            className="flex min-h-0 min-w-0 flex-col"
          >
            <div
              ref={profileWrapRef}
              className="flex min-h-0 min-w-0 flex-1 flex-col bg-primary animate-in fade-in slide-in-from-right-6 motion-enter"
            >
              {profile}
            </div>
          </Panel>
        </Group>
      ) : (
        <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <div
            inert={profileOpen || undefined}
            aria-hidden={profileOpen || undefined}
            className="flex min-h-0 min-w-0 flex-1"
          >
            {directoryPane}
          </div>
          <AnimatePresence initial={false}>
            {profileOpen && (
              <SwipeableProfileOverlay
                key={profileKey}
                reduced={reduced}
                onBack={closeAgentProfile}
              >
                {profile}
              </SwipeableProfileOverlay>
            )}
          </AnimatePresence>
        </div>
      )}

      <MemberDialogs
        dialog={dialog}
        onDialogChange={(next) => {
          if (!next) setCreateAgentKind(undefined);
          onDialogChange(next);
        }}
        allowed={canInviteMember}
        agentKind={createAgentKind}
      />
    </main>
  );
}

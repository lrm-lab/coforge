import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { useHydrated } from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";
import { AlertCircle, SearchLg as Search, UsersPlus } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { Tab, TabList, TabPanel, Tabs } from "#src/components/application/tabs/tabs";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import { PageBackButton } from "#src/components/layout/page-back-button";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { Skeleton } from "#src/components/ui/skeleton";
import { localLayoutStorage } from "#src/features/conversations/local-layout-storage";
import type { MemberDirectorySummary } from "#src/features/workspaces/workspaces.functions";
import { isWorkspaceAdminRole } from "#src/features/workspaces/workspace-roles";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { useEdgeSwipeBack } from "#src/hooks/use-edge-swipe-back";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { formatNumber } from "#src/lib/format-number";
import {
  animateFlipFromRect,
  cancelFlipAnimation,
  consumeSharedRect,
} from "#src/lib/shared-element-rect";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { DURATION_S, EASE_IN, EASE_OUT } from "#src/utils/motion-tokens";

import { pickBusyAgents } from "./busy-agents";
import { MemberDialogs, type MemberDialog } from "./member-dialogs";
import { memberAgentsQuery, memberPeopleQuery } from "./member-directory-queries";
import {
  AgentsTableView,
  AllMembersView,
  COMPACT_CARD_GRID_CLASS,
  CreateAgentSplitButton,
  HumansDirectoryView,
} from "./member-directory-views";
import type { AgentCreateKind } from "./new-agent-dialog";
import { PersonProfilePanel } from "./person-profile-panel";
import { AgentProfilePanel } from "./profile-panel/agent-profile-panel";
import { useOpenAgentProfile } from "./profile-panel/open-agent-profile";
import type { AgentProfileTab } from "./profile-panel/profile-panel-search";
import { WorkspaceAgentUsageView } from "./workspace-agent-usage-view";
import { useLiveWorkspaceAgents } from "./workspace-agents-realtime";

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
  const locale = getLocale();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [createAgentKind, setCreateAgentKind] = useState<AgentCreateKind | undefined>(undefined);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const busyCount = useLiveWorkspaceAgents(pickBusyAgents).length;
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
    setSearch("");
    setQuery("");
  };

  const profileOpen = Boolean(profileAgentId || profilePersonId);
  const hydrated = useHydrated();
  const desktop = useBreakpoint("md");
  const splitOpen = hydrated && desktop && profileOpen;
  const profile = profileAgentId ? (
    <AgentProfilePanel
      agentId={profileAgentId}
      requestedTab={agentTab}
      onTabChange={setAgentProfileTab}
      onClose={closeAgentProfile}
      pageHeading={!splitOpen}
    />
  ) : profilePersonId ? (
    <PersonProfilePanel
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
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-secondary px-page">
        <PageBackButton />
        <h1 className="truncate text-lg font-semibold text-primary">
          {m.member_directory_title()}
        </h1>
        <p className="hidden min-w-0 items-center gap-3 truncate text-xs text-tertiary tabular-nums sm:flex">
          <span>{m.member_working_summary({ working: busyCount })}</span>
          <span>{m.member_total_summary({ count: totalCount })}</span>
        </p>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2.5 px-page pt-4 pb-3">
        <TabList
          aria-label={m.member_type_filter()}
          type="button-minimal"
          size="sm"
          className="shrink-0"
        >
          <Tab id="all" className="tabular-nums">
            <span>{m.member_tab_all()}</span>
            <span className="text-quaternary">{formatNumber(totalCount, locale)}</span>
          </Tab>
          <Tab id="human" className="tabular-nums">
            <span>{m.member_tab_humans()}</span>
            <span className="text-quaternary">{formatNumber(summary.peopleCount, locale)}</span>
          </Tab>
          <Tab id="agent" className="tabular-nums">
            <span>{m.member_tab_agents()}</span>
            <span className="text-quaternary">{formatNumber(summary.agentCount, locale)}</span>
          </Tab>
        </TabList>

        <Input
          type="search"
          size="sm"
          icon={Search}
          aria-label={searchLabel}
          placeholder={searchLabel}
          value={search}
          onChange={setSearch}
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
          <WorkspaceAgentUsageView
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
  const swipe = useEdgeSwipeBack({
    enabled: !splitOpen && profileOpen && !reduced,
    onBack: closeAgentProfile,
  });

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
              <motion.div
                key={profileKey}
                ref={profileWrapRef}
                {...swipe.bind}
                initial={reduced ? { opacity: 0 } : { x: "100%" }}
                animate={
                  reduced
                    ? { opacity: 1 }
                    : swipe.dragging
                      ? { x: `${swipe.dragProgress * 100}%` }
                      : { x: 0 }
                }
                exit={
                  reduced
                    ? { opacity: 0, transition: { duration: DURATION_S.reduced } }
                    : { x: "100%", transition: { duration: DURATION_S.lgOut, ease: EASE_IN } }
                }
                transition={
                  swipe.dragging
                    ? { duration: 0 }
                    : reduced
                      ? { duration: DURATION_S.reduced }
                      : swipe.settling
                        ? { type: "spring", stiffness: 380, damping: 32 }
                        : { duration: DURATION_S.lg, ease: EASE_OUT }
                }
                className="absolute inset-0 z-20 flex min-h-0 min-w-0 touch-pan-y flex-col bg-primary will-change-transform"
              >
                {profile}
              </motion.div>
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

const SEARCH_DEBOUNCE_MS = 250;

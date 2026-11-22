import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { GridList, GridListLoadMoreItem, ProgressBar } from "react-aria-components";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { getRouteApi } from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { useEdgeSwipeBack } from "#src/hooks/use-edge-swipe-back";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import {
  animateFlipFromRect,
  cancelFlipAnimation,
  consumeSharedRect,
} from "#src/lib/shared-element-rect";
import { DURATION_S, EASE_IN, EASE_OUT } from "#src/utils/motion-tokens";
import { Plus, SearchLg as Search, UsersPlus } from "@untitledui/icons";
import { CircleAlert } from "kubai-icons/duotone";
import { Spinner } from "#src/components/ui/spinner";

import { Tab, TabList, TabPanel, Tabs } from "#src/components/application/tabs/tabs";
import { ButtonGroup, ButtonGroupItem } from "#src/components/base/button-group/button-group";
import { PageBackButton } from "#src/components/layout/page-back-button";
import { formatCalendarDate } from "#src/lib/dates";
import { getLocale } from "#src/paraglide/runtime";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { MembersWireframe, NoResultsWireframe } from "#src/components/ui/empty-wireframes";
import { Skeleton } from "#src/components/ui/skeleton";
import { m } from "#src/paraglide/messages";
import { localLayoutStorage } from "#src/features/conversations/local-layout-storage";

import { MemberDialogs, type MemberDialog } from "./member-dialogs";
import { AgentDeleteDialog } from "./agent-delete-dialog";
import type { MemberDirectorySummary } from "#src/features/workspaces/workspaces.functions";
import { memberAgentsQuery, memberPeopleQuery } from "./member-directory-queries";
import { AgentProfilePanel } from "#src/features/agents/profile-panel/agent-profile-panel";
import { useOpenAgentProfile } from "#src/features/agents/profile-panel/open-agent-profile";
import type { AgentProfileTab } from "#src/features/agents/profile-panel/profile-panel-search";
import { PersonProfilePanel } from "./person-profile-panel";
import { AgentCard, PersonCard } from "./member-cards";

const appRoute = getRouteApi("/w/$workspaceSlug");

export type MemberTab = "agent" | "human";
export type OwnerFilter = "all" | "mine";

export function AgentsContent({
  summary,
  memberType,
  owner,
  onFiltersChange,
  profileAgentId,
  profilePersonId,
  agentTab,
  onDeleteAgent,
  dialog,
  onDialogChange,
}: {
  summary: MemberDirectorySummary;
  memberType: MemberTab;
  owner: OwnerFilter;
  onFiltersChange: (filters: { memberType?: MemberTab; owner?: OwnerFilter }) => void;
  profileAgentId?: string;
  profilePersonId?: string;
  agentTab?: AgentProfileTab;
  onDeleteAgent: (agentId: string, confirmation: string) => Promise<void>;
  dialog?: MemberDialog;
  onDialogChange: (dialog: MemberDialog | undefined) => void;
}) {
  const { setAgentProfileTab, closeAgentProfile } = useOpenAgentProfile();
  const timeZone = appRoute.useLoaderData().timeZone;
  const locale = getLocale();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const canInviteMember = summary.actorRole === "owner" || summary.actorRole === "admin";
  const canCreateAgent = canInviteMember;
  const canDeleteAgent = canInviteMember;
  const onAgentTab = memberType === "agent";
  const tabTotal = onAgentTab ? summary.agentCount : summary.peopleCount;
  const filtersActive = onAgentTab && owner === "mine";
  const searchLabel = onAgentTab ? m.member_search_agents() : m.member_search_humans();
  const agentPages = useInfiniteQuery({
    ...memberAgentsQuery(summary.workspaceId, { owner, query }),
    enabled: onAgentTab,
    placeholderData: keepPreviousData,
  });
  const peoplePages = useInfiniteQuery({
    ...memberPeopleQuery(summary.workspaceId, query),
    enabled: !onAgentTab,
    placeholderData: keepPreviousData,
  });
  const pages = onAgentTab ? agentPages : peoplePages;
  const listedAgents = onAgentTab
    ? (agentPages.data?.pages.flatMap((page) => page.items) ?? [])
    : [];
  const listedPeople = onAgentTab
    ? []
    : (peoplePages.data?.pages.flatMap((page) => page.items) ?? []);
  const loadMore = () => {
    if (pages.hasNextPage && !pages.isFetchingNextPage) void pages.fetchNextPage();
  };
  const profileOpen = Boolean(profileAgentId || profilePersonId);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
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

  const directoryPane = (
    <Tabs
      selectedKey={memberType}
      onSelectionChange={(key) => {
        if (key === "agent" || key === "human") onFiltersChange({ memberType: key });
      }}
      className="@container/members min-h-0 min-w-0 flex-1"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 border-b border-secondary px-page @2xl/members:grid @2xl/members:h-12 @2xl/members:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <div className="flex h-12 min-w-0 flex-1 items-center gap-3">
          <PageBackButton />
          <h1 className="truncate text-lg font-semibold text-primary">
            {m.member_directory_title()}
          </h1>
        </div>
        <div className="order-last flex basis-full self-end @2xl/members:order-none @2xl/members:basis-auto">
          <TabList
            aria-label={m.member_type_filter()}
            type="underline"
            className="gap-6 before:hidden"
          >
            <Tab id="agent">{m.member_tab_agents_count({ count: summary.agentCount })}</Tab>
            <Tab id="human">{m.member_tab_humans_count({ count: summary.peopleCount })}</Tab>
          </TabList>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2 @2xl/members:justify-self-end">
          {onAgentTab
            ? canCreateAgent && (
                <Button
                  size="sm"
                  color="secondary"
                  iconLeading={Plus}
                  onPress={() => onDialogChange("create-agent")}
                >
                  {m.header_new_agent()}
                </Button>
              )
            : canInviteMember && (
                <Button
                  size="sm"
                  color="secondary"
                  iconLeading={UsersPlus}
                  onPress={() => onDialogChange("invite")}
                >
                  {m.member_invite_humans()}
                </Button>
              )}
        </div>
      </header>
      {tabTotal > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-3 px-page pt-5">
          {onAgentTab && (
            <ButtonGroup
              aria-label={m.member_owner_filter()}
              size="sm"
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={[owner]}
              onSelectionChange={(keys) => {
                const [next] = [...keys];
                if (next === "all" || next === "mine") onFiltersChange({ owner: next });
              }}
            >
              <ButtonGroupItem id="mine">{m.filters_mine()}</ButtonGroupItem>
              <ButtonGroupItem id="all">{m.filters_all()}</ButtonGroupItem>
            </ButtonGroup>
          )}
          <Input
            type="search"
            size="sm"
            icon={Search}
            aria-label={searchLabel}
            placeholder={`${searchLabel}...`}
            value={search}
            onChange={setSearch}
            className="w-full sm:w-80"
          />
        </div>
      )}
      <TabPanel
        id={memberType}
        className="relative flex min-h-0 flex-1 flex-col overflow-y-auto px-page pb-8"
      >
        {pages.isError && !pages.data ? (
          <EmptyState
            size="page"
            role="alert"
            picture={<EmptyIcon icon={CircleAlert} />}
            title={m.empty_members_load_failed_title()}
            description={m.empty_load_failed_safe()}
            primaryAction={
              <RetryButton
                size="page"
                isRetrying={pages.isRefetching}
                onPress={() => void pages.refetch()}
              />
            }
          />
        ) : pages.isPending ? (
          <div
            role="status"
            aria-label={m.agents_loading()}
            className="mt-4 grid gap-4 md:grid-cols-[repeat(auto-fill,minmax(26rem,1fr))]"
          >
            <Skeleton className="h-32 rounded-xl" />
            <Skeleton className="h-32 rounded-xl" />
            <Skeleton className="h-32 rounded-xl" />
          </div>
        ) : listedPeople.length + listedAgents.length ? (
          <GridList
            aria-label={onAgentTab ? m.member_tab_agents() : m.member_tab_humans()}
            layout="grid"
            className="mt-4 grid gap-4 outline-none md:grid-cols-[repeat(auto-fill,minmax(26rem,1fr))]"
          >
            {listedPeople.map((person) => (
              <PersonCard
                key={person.id}
                person={person}
                selected={person.id === profilePersonId}
              />
            ))}
            {listedAgents.map((member) => (
              <AgentCard
                key={member.id}
                member={member}
                selected={member.id === profileAgentId}
                createdOn={
                  timeZone || hydrated ? formatCalendarDate(member.createdAt, timeZone, locale) : ""
                }
                canEdit={canInviteMember || member.owner.id === summary.viewerId}
                onDelete={
                  canDeleteAgent && member.deletable
                    ? () => {
                        setDeleteTarget({ id: member.id, name: member.name });
                        setDeleteOpen(true);
                      }
                    : undefined
                }
              />
            ))}
            <GridListLoadMoreItem
              onLoadMore={loadMore}
              isLoading={pages.isFetchingNextPage}
              className="col-span-full flex justify-center py-4"
            >
              <ProgressBar
                isIndeterminate
                aria-label={m.member_loading_more()}
                className="text-fg-quaternary"
              >
                <Spinner />
              </ProgressBar>
            </GridListLoadMoreItem>
          </GridList>
        ) : null}
        {pages.isFetchNextPageError ? (
          <EmptyState
            size="row"
            role="alert"
            className="mt-4"
            title={m.empty_members_load_failed_title()}
            primaryAction={
              <RetryButton
                size="row"
                isRetrying={pages.isFetchingNextPage}
                onPress={() => void pages.fetchNextPage()}
              />
            }
          />
        ) : pages.isError || pages.isPending || listedPeople.length + listedAgents.length ? null : (
          <EmptyState
            size="page"
            headingLevel={2}
            live={tabTotal ? "polite" : undefined}
            picture={
              tabTotal ? (
                <NoResultsWireframe />
              ) : (
                <MembersWireframe accent={onAgentTab ? canCreateAgent : canInviteMember} />
              )
            }
            title={
              tabTotal
                ? query.trim()
                  ? m.empty_members_no_match_query({ query: query.trim() })
                  : filtersActive
                    ? m.empty_members_filter_empty_title()
                    : m.agent_no_search_results()
                : onAgentTab
                  ? m.agent_empty_title()
                  : m.empty_members_humans_title()
            }
            description={
              tabTotal
                ? filtersActive
                  ? m.member_filter_empty_description()
                  : m.agent_search_description()
                : onAgentTab
                  ? m.empty_members_agents_description()
                  : m.empty_members_humans_description()
            }
            primaryAction={
              tabTotal ? (
                <Button
                  size="sm"
                  color="secondary"
                  onPress={() => {
                    setSearch("");
                    setQuery("");
                    if (filtersActive) onFiltersChange({ owner: "all" });
                  }}
                >
                  {filtersActive ? m.member_clear_filters() : m.agent_clear_search()}
                </Button>
              ) : onAgentTab && canCreateAgent ? (
                <Button size="sm" iconLeading={Plus} onPress={() => onDialogChange("create-agent")}>
                  {m.header_new_agent()}
                </Button>
              ) : !onAgentTab && canInviteMember ? (
                <Button size="sm" iconLeading={UsersPlus} onPress={() => onDialogChange("invite")}>
                  {m.member_invite_humans()}
                </Button>
              ) : undefined
            }
          />
        )}
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
                className="absolute inset-0 z-20 flex min-h-0 min-w-0 touch-pan-y flex-col bg-primary shadow-2xl will-change-transform"
              >
                {profile}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      <MemberDialogs dialog={dialog} onDialogChange={onDialogChange} allowed={canInviteMember} />

      <AgentDeleteDialog
        key={deleteTarget?.id}
        agentName={deleteTarget?.name ?? ""}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDelete={async (confirmation) => {
          if (!deleteTarget) return;
          await onDeleteAgent(deleteTarget.id, confirmation);
          if (deleteTarget.id === profileAgentId) closeAgentProfile();
          setDeleteOpen(false);
        }}
      />
    </main>
  );
}

const SEARCH_DEBOUNCE_MS = 250;

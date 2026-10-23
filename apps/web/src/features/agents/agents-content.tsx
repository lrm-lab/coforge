import { useEffect, useState } from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { GridList, GridListLoadMoreItem, ProgressBar } from "react-aria-components";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { getRouteApi } from "@tanstack/react-router";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { Plus, SearchLg as Search, Users01 as UsersRound, UsersPlus } from "@untitledui/icons";
import { Spinner } from "#src/components/ui/spinner";

import { Tab, TabList, TabPanel, Tabs } from "#src/components/application/tabs/tabs";
import { ButtonGroup, ButtonGroupItem } from "#src/components/base/button-group/button-group";
import { MobileNavigationButton } from "#src/components/layout/sidebar/mobile-header";
import { formatCalendarDate } from "#src/lib/dates";
import { getLocale } from "#src/paraglide/runtime";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#src/components/ui/empty";
import { m } from "#src/paraglide/messages";
import { localLayoutStorage } from "#src/features/conversations/local-layout-storage";
import type { AgentStatusView } from "./agent-status-realtime";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { MemberDialogs, type MemberDialog } from "./member-dialogs";
import { AgentDeleteDialog } from "./agent-delete-dialog";
import type { RuntimeCatalog } from "./agent-runtime-fields";
import type { CreateAgentInput } from "./agent.schemas";
import type { MemberDirectorySummary } from "#src/features/workspaces/workspaces.functions";
import { memberAgentsQuery, memberPeopleQuery } from "./member-directory-queries";
import { AgentProfilePanel } from "#src/features/agents/profile-panel/agent-profile-panel";
import { useOpenAgentProfile } from "#src/features/agents/profile-panel/open-agent-profile";
import type { AgentProfileTab } from "#src/features/agents/profile-panel/profile-panel-search";
import { PersonProfilePanel } from "./person-profile-panel";
import { AgentCard, PersonCard } from "./member-cards";

type ComputerOption = {
  id: string;
  name: string;
  displayName: string;
  online?: boolean;
  runtimes: { provider: string }[];
};

const appRoute = getRouteApi("/w/$workspaceSlug");

export type AgentView = {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  status: AgentStatusView;
  display?: AgentDisplaySnapshot;
};

export type MemberTab = "agent" | "human";
export type OwnerFilter = "all" | "mine";

export function AgentsContent({
  summary,
  memberType,
  owner,
  onFiltersChange,
  agents,
  computers,
  profileAgentId,
  profilePersonId,
  agentTab,
  onCreate,
  onLoadRuntimeCatalog,
  onDeleteAgent,
  dialog,
  onDialogChange,
}: {
  summary: MemberDirectorySummary;
  memberType: MemberTab;
  owner: OwnerFilter;
  onFiltersChange: (filters: { memberType?: MemberTab; owner?: OwnerFilter }) => void;
  agents: AgentView[];
  computers: ComputerOption[];
  profileAgentId?: string;
  /** The person whose profile the panel shows (`profile=user:<id>`). */
  profilePersonId?: string;
  agentTab?: AgentProfileTab;
  onCreate: (input: CreateAgentInput) => Promise<{ startPublished: boolean }>;
  onLoadRuntimeCatalog: (computerId: string) => Promise<RuntimeCatalog[]>;
  onDeleteAgent: (agentId: string, confirmation: string) => Promise<void>;
  dialog?: MemberDialog;
  onDialogChange: (dialog: MemberDialog | undefined) => void;
}) {
  const { setAgentProfileTab, closeAgentProfile } = useOpenAgentProfile();
  const timeZone = appRoute.useLoaderData().timeZone;
  const locale = getLocale();
  const [search, setSearch] = useState("");
  // The server searches; wait for a pause in typing instead of fetching on every keystroke.
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);
  // The target outlives `deleteOpen` so the dialog keeps its title through the close animation.
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deferredStart, setDeferredStart] = useState(false);
  const canInviteMember = summary.actorRole === "owner" || summary.actorRole === "admin";
  // Agent creation requires Workspace owner/admin; see ManageAgents.create / assertCanCreateAgents.
  const canCreateAgent = canInviteMember;
  // Deletion is the same owner/admin capability, and only for Agents the directory marks
  // deletable; the server re-checks both.
  const canDeleteAgent = canInviteMember;
  const onAgentTab = memberType === "agent";
  const tabTotal = onAgentTab ? summary.agentCount : summary.peopleCount;
  const ownedAgents = new Map(agents.map((agent) => [agent.id, agent]));
  const filtersActive = onAgentTab && owner === "mine";
  const searchLabel = onAgentTab ? m.member_search_agents() : m.member_search_humans();
  // Keep the cards already on screen while a changed filter or search loads its first page.
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
  const profile = profileAgentId ? (
    <AgentProfilePanel
      agentId={profileAgentId}
      requestedTab={agentTab}
      onTabChange={setAgentProfileTab}
      onClose={closeAgentProfile}
    />
  ) : profilePersonId ? (
    <PersonProfilePanel
      // A fresh panel per person, so one never shows another's state while it loads.
      key={profilePersonId}
      userId={profilePersonId}
      onClose={closeAgentProfile}
    />
  ) : null;
  const profileOpen = profile !== null;
  // `useBreakpoint` is true during SSR for a desktop's request (a phone's request assumes narrow,
  // `AssumedViewportProvider`), which cannot tell a narrow desktop window. Stay stacked until after
  // mount so a phone never first-paints the profile as a 35% column with a blank left side.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const desktop = useBreakpoint("md");
  const splitOpen = mounted && desktop && profileOpen;
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
      {/* One row with centred tabs once the pane (not the viewport) is wide enough; narrower, as
       * on a phone or beside the profile panel, the tabs wrap onto their own row. */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 border-b border-secondary px-page @2xl/members:grid @2xl/members:h-12 @2xl/members:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <div className="flex h-12 min-w-0 flex-1 items-center gap-3">
          <MobileNavigationButton />
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
                  color="primary"
                  iconLeading={Plus}
                  onPress={() => onDialogChange("create-agent")}
                >
                  {m.header_new_agent()}
                </Button>
              )
            : canInviteMember && (
                <Button
                  size="sm"
                  color="primary"
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
      {/* `relative` makes the list the containing block of the cards' absolutely positioned
          `sr-only` labels; without it they escape this scroll box and stretch the document. */}
      <TabPanel id={memberType} className="relative min-h-0 flex-1 overflow-y-auto px-page pb-8">
        {deferredStart && (
          <p
            role="status"
            className="mt-5 rounded-lg border border-secondary bg-secondary px-4 py-3 text-sm text-tertiary"
          >
            {m.agent_deferred_start_notice()}
          </p>
        )}
        {pages.isError && !pages.data ? (
          <div role="alert" className="mt-8 flex flex-col items-center gap-3 text-center">
            <p className="text-sm text-error-primary">{m.member_directory_load_error()}</p>
            <Button size="sm" color="secondary" onPress={() => void pages.refetch()}>
              {m.controls_retry()}
            </Button>
          </div>
        ) : pages.isPending ? null : listedPeople.length + listedAgents.length ? (
          <GridList
            aria-label={onAgentTab ? m.member_tab_agents() : m.member_tab_humans()}
            layout="grid"
            className="mt-4 grid gap-4 outline-none md:grid-cols-[repeat(auto-fill,minmax(18rem,1fr))]"
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
                ownedAgent={ownedAgents.get(member.id)}
                selected={member.id === profileAgentId}
                // Without a time-zone preference the server and browser zones differ, so the date
                // is only formatted after mount (the same rule as RelativeTime).
                createdOn={
                  timeZone || mounted ? formatCalendarDate(member.createdAt, timeZone, locale) : ""
                }
                // Editing follows the profile panel's rule: Workspace owner/admin or the creator.
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
            {/* React Aria asks for the next page as this sentinel nears the scroll area's end. */}
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
          // React Aria re-arms its sentinel only when the list changes, so a failed page needs an
          // explicit retry or the list would silently end early.
          <div role="alert" className="mt-4 flex flex-col items-center gap-3 text-center">
            <p className="text-sm text-error-primary">{m.member_directory_load_error()}</p>
            <Button size="sm" color="secondary" onPress={() => void pages.fetchNextPage()}>
              {m.controls_retry()}
            </Button>
          </div>
        ) : pages.isError || pages.isPending || listedPeople.length + listedAgents.length ? null : (
          <Empty
            className={
              tabTotal ? "gap-5 px-0 py-12" : "gap-6 px-0 pt-[clamp(3rem,12svh,7rem)] pb-10"
            }
          >
            <EmptyHeader className="max-w-xs gap-3">
              {tabTotal ? (
                <EmptyMedia>
                  <Search aria-hidden="true" className="size-8 text-tertiary" strokeWidth={1.5} />
                </EmptyMedia>
              ) : (
                <EmptyMedia aria-hidden="true" className="relative mb-3 h-28 w-44">
                  <span className="absolute inset-x-2 top-0 h-24 rounded-full bg-secondary" />
                  <UsersRound className="relative size-20 text-tertiary" strokeWidth={1} />
                  <span className="absolute right-2 bottom-0 flex size-10 items-center justify-center rounded-xl border border-secondary bg-primary text-tertiary shadow-sm">
                    <Plus className="size-5" />
                  </span>
                </EmptyMedia>
              )}
              <EmptyTitle role="heading" aria-level={2} className="text-lg font-semibold">
                {tabTotal
                  ? m.agent_no_search_results()
                  : onAgentTab
                    ? m.agent_empty_title()
                    : m.member_no_humans()}
              </EmptyTitle>
              <EmptyDescription>
                {tabTotal
                  ? filtersActive
                    ? m.member_filter_empty_description()
                    : m.agent_search_description()
                  : onAgentTab
                    ? m.agent_empty_description()
                    : null}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              {tabTotal ? (
                <Button
                  color="secondary"
                  onPress={() => {
                    setSearch("");
                    setQuery("");
                    if (filtersActive) onFiltersChange({ owner: "all" });
                  }}
                >
                  {filtersActive ? m.member_clear_filters() : m.agent_clear_search()}
                </Button>
              ) : null}
            </EmptyContent>
          </Empty>
        )}
      </TabPanel>
    </Tabs>
  );

  return (
    <main className="flex h-full min-w-0 bg-primary">
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
            {profile}
          </Panel>
        </Group>
      ) : profileOpen ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{profile}</div>
      ) : (
        directoryPane
      )}

      <MemberDialogs
        dialog={dialog}
        onDialogChange={onDialogChange}
        allowed={canInviteMember}
        computers={computers}
        onCreate={onCreate}
        onLoadRuntimeCatalog={onLoadRuntimeCatalog}
        onCreated={(result) => setDeferredStart(!result.startPublished)}
      />

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

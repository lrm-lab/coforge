import { GridList, GridListLoadMoreItem, ProgressBar } from "react-aria-components";
import { ChevronDown, Cloud01, Link01, Monitor01, Plus, UsersPlus } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { EmptyState } from "#src/components/ui/empty";
import { MembersWireframe, NoResultsWireframe } from "#src/components/ui/empty-wireframes";
import { Spinner } from "#src/components/ui/spinner";
import type { MemberAgent, MemberPerson } from "#src/features/workspaces/workspaces.functions";
import { formatNumber } from "#src/lib/format-number";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";

import {
  AGENT_TABLE_CREATOR_COL_CLASS,
  AGENT_TABLE_GRID_CLASS,
  AgentCard,
  AgentDirectoryRow,
  PersonCard,
} from "./member-cards";
import type { AgentCreateKind } from "./new-agent-dialog";

export const COMPACT_CARD_GRID_CLASS =
  "grid gap-3 outline-none grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))]";

const SPLIT_CHEVRON_CLASS = "-ms-px rounded-s-none before:rounded-s-none before:border-s-0 px-2";

export function CreateAgentSplitButton({
  onCreate,
}: {
  onCreate: (kind?: AgentCreateKind) => void;
}) {
  return (
    <div className="flex shrink-0 items-center">
      <Button
        size="sm"
        color="primary"
        iconLeading={Plus}
        className="rounded-e-none before:rounded-e-none before:border-e-0"
        onPress={() => onCreate(undefined)}
      >
        {m.header_new_agent()}
      </Button>
      <Dropdown.Root>
        <Button
          size="sm"
          color="primary"
          iconLeading={ChevronDown}
          aria-label={m.member_create_agent_options()}
          className={SPLIT_CHEVRON_CLASS}
        />
        <Dropdown.Popover placement="bottom end" className="w-48">
          <Dropdown.Menu
            aria-label={m.member_create_agent_options()}
            onAction={(key) => {
              if (key === "cloud" || key === "local" || key === "external") {
                onCreate(key);
              }
            }}
          >
            <Dropdown.Item id="cloud" icon={Cloud01} label={m.agent_create_kind_cloud()} />
            <Dropdown.Item id="local" icon={Monitor01} label={m.agent_create_kind_local()} />
            <Dropdown.Item id="external" icon={Link01} label={m.agent_create_kind_external()} />
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
    </div>
  );
}

export function AllMembersView({
  people,
  agents,
  peopleCount,
  agentCount,
  viewerId,
  profilePersonId,
  profileAgentId,
  query,
  canCreateAgent,
  isFetchingMorePeople,
  isFetchingMoreAgents,
  onLoadMorePeople,
  onLoadMoreAgents,
  onClearSearch,
  onCreateAgent,
}: {
  people: MemberPerson[];
  agents: MemberAgent[];
  peopleCount: number;
  agentCount: number;
  viewerId: string;
  profilePersonId?: string;
  profileAgentId?: string;
  query: string;
  canCreateAgent: boolean;
  isFetchingMorePeople: boolean;
  isFetchingMoreAgents: boolean;
  onLoadMorePeople: () => void;
  onLoadMoreAgents: () => void;
  onClearSearch: () => void;
  onCreateAgent: () => void;
}) {
  const locale = getLocale();
  const trimmedQuery = query.trim();
  const totalVisible = people.length + agents.length;

  if (totalVisible === 0 && trimmedQuery) {
    return (
      <EmptyState
        size="page"
        headingLevel={2}
        live="polite"
        picture={<NoResultsWireframe />}
        title={m.empty_members_no_match_query({ query: trimmedQuery })}
        description={m.agent_search_description()}
        primaryAction={
          <Button size="sm" color="secondary" onPress={onClearSearch}>
            {m.agent_clear_search()}
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      {(people.length > 0 || !trimmedQuery) && (
        <section className="space-y-2.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-tertiary">
            <span>{m.member_tab_humans()}</span>
            <span className="tabular-nums text-quaternary">
              {formatNumber(trimmedQuery ? people.length : peopleCount, locale)}
            </span>
          </div>
          {people.length > 0 ? (
            <GridList
              aria-label={m.member_tab_humans()}
              layout="grid"
              className={COMPACT_CARD_GRID_CLASS}
            >
              {people.map((person) => (
                <PersonCard
                  key={person.id}
                  person={person}
                  isSelf={person.id === viewerId}
                  selected={person.id === profilePersonId}
                />
              ))}
              <GridListLoadMoreItem
                onLoadMore={onLoadMorePeople}
                isLoading={isFetchingMorePeople}
                className="col-span-full flex justify-center py-2"
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
        </section>
      )}

      {(agents.length > 0 || !trimmedQuery) && (
        <section className="space-y-2.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-tertiary">
            <span>{m.member_tab_agents()}</span>
            <span className="tabular-nums text-quaternary">
              {formatNumber(trimmedQuery ? agents.length : agentCount, locale)}
            </span>
          </div>
          {agents.length > 0 ? (
            <GridList
              aria-label={m.member_tab_agents()}
              layout="grid"
              className={COMPACT_CARD_GRID_CLASS}
            >
              {agents.map((member) => (
                <AgentCard
                  key={member.id}
                  member={member}
                  selected={member.id === profileAgentId}
                />
              ))}
              <GridListLoadMoreItem
                onLoadMore={onLoadMoreAgents}
                isLoading={isFetchingMoreAgents}
                className="col-span-full flex justify-center py-2"
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
          ) : (
            <EmptyState
              size="card"
              headingLevel={2}
              picture={<MembersWireframe accent={canCreateAgent} />}
              title={m.agent_empty_title()}
              description={m.empty_members_agents_description()}
              primaryAction={
                canCreateAgent ? (
                  <Button size="sm" iconLeading={Plus} onPress={onCreateAgent}>
                    {m.header_new_agent()}
                  </Button>
                ) : undefined
              }
            />
          )}
        </section>
      )}
    </div>
  );
}

export function HumansDirectoryView({
  people,
  peopleCount,
  viewerId,
  profilePersonId,
  query,
  canInviteMember,
  isFetchingMore,
  onLoadMore,
  onClearSearch,
  onInvite,
}: {
  people: MemberPerson[];
  peopleCount: number;
  viewerId: string;
  profilePersonId?: string;
  query: string;
  canInviteMember: boolean;
  isFetchingMore: boolean;
  onLoadMore: () => void;
  onClearSearch: () => void;
  onInvite: () => void;
}) {
  const trimmedQuery = query.trim();

  if (people.length > 0) {
    return (
      <GridList
        aria-label={m.member_tab_humans()}
        layout="grid"
        className={COMPACT_CARD_GRID_CLASS}
      >
        {people.map((person) => (
          <PersonCard
            key={person.id}
            person={person}
            isSelf={person.id === viewerId}
            selected={person.id === profilePersonId}
          />
        ))}
        <GridListLoadMoreItem
          onLoadMore={onLoadMore}
          isLoading={isFetchingMore}
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
    );
  }

  return (
    <EmptyState
      size="page"
      headingLevel={2}
      live={peopleCount ? "polite" : undefined}
      picture={peopleCount ? <NoResultsWireframe /> : <MembersWireframe accent={canInviteMember} />}
      title={
        peopleCount
          ? trimmedQuery
            ? m.empty_members_no_match_query({ query: trimmedQuery })
            : m.agent_no_search_results()
          : m.empty_members_humans_title()
      }
      description={
        peopleCount ? m.agent_search_description() : m.empty_members_humans_description()
      }
      primaryAction={
        peopleCount ? (
          <Button size="sm" color="secondary" onPress={onClearSearch}>
            {m.agent_clear_search()}
          </Button>
        ) : canInviteMember ? (
          <Button size="sm" iconLeading={UsersPlus} onPress={onInvite}>
            {m.member_invite_humans()}
          </Button>
        ) : undefined
      }
    />
  );
}

export function AgentsTableView({
  agents,
  agentCount,
  profileAgentId,
  query,
  filtersActive,
  canCreateAgent,
  isFetchingMore,
  onLoadMore,
  onClearFilters,
  onCreateAgent,
}: {
  agents: MemberAgent[];
  agentCount: number;
  profileAgentId?: string;
  query: string;
  filtersActive: boolean;
  canCreateAgent: boolean;
  isFetchingMore: boolean;
  onLoadMore: () => void;
  onClearFilters: () => void;
  onCreateAgent: () => void;
}) {
  const trimmedQuery = query.trim();

  if (agents.length > 0) {
    return (
      <div className="shrink-0 overflow-hidden rounded-xl border border-secondary bg-primary">
        <div
          aria-hidden="true"
          className={`hidden border-b border-secondary px-4 py-2.5 text-xs font-medium text-tertiary ${AGENT_TABLE_GRID_CLASS}`}
        >
          <span>{m.member_table_col_agent()}</span>
          <span>{m.member_table_col_model()}</span>
          <span>{m.member_table_col_computer()}</span>
          <span className={AGENT_TABLE_CREATOR_COL_CLASS}>{m.member_table_col_owner()}</span>
        </div>
        <GridList
          aria-label={m.member_tab_agents()}
          className="divide-y divide-secondary outline-none"
        >
          {agents.map((member) => (
            <AgentDirectoryRow
              key={member.id}
              member={member}
              selected={member.id === profileAgentId}
            />
          ))}
          <GridListLoadMoreItem
            onLoadMore={onLoadMore}
            isLoading={isFetchingMore}
            className="flex justify-center py-4"
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
      </div>
    );
  }

  return (
    <EmptyState
      size="page"
      headingLevel={2}
      live={agentCount ? "polite" : undefined}
      picture={agentCount ? <NoResultsWireframe /> : <MembersWireframe accent={canCreateAgent} />}
      title={
        agentCount
          ? trimmedQuery
            ? m.empty_members_no_match_query({ query: trimmedQuery })
            : filtersActive
              ? m.empty_members_filter_empty_title()
              : m.agent_no_search_results()
          : m.agent_empty_title()
      }
      description={
        agentCount
          ? filtersActive
            ? m.member_filter_empty_description()
            : m.agent_search_description()
          : m.empty_members_agents_description()
      }
      primaryAction={
        agentCount ? (
          <Button size="sm" color="secondary" onPress={onClearFilters}>
            {filtersActive ? m.member_clear_filters() : m.agent_clear_search()}
          </Button>
        ) : canCreateAgent ? (
          <Button size="sm" iconLeading={Plus} onPress={onCreateAgent}>
            {m.header_new_agent()}
          </Button>
        ) : undefined
      }
    />
  );
}

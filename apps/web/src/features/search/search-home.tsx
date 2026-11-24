import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { SearchLg, XClose } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { Skeleton } from "#src/components/ui/skeleton";
import { m } from "#src/paraglide/messages";
import type { SearchEntity } from "./search-entities";
import { SEARCH_HEADING_CLASS, SEARCH_ROW_CLASS, SearchEntityRow } from "./search-entity-list";
import { frequentEntities, type RememberedEntity, type SearchUsage } from "./search-memory";
import { searchDirectoryQuery } from "./search-queries";

export function SearchHome({
  workspaceId,
  channel,
  history,
  usage,
  onSearch,
  onRemoveSearch,
  onClearHistory,
  onOpen,
}: {
  workspaceId: string;
  channel?: string;
  history: readonly string[];
  usage: SearchUsage;
  onSearch: (query: string) => void;
  onRemoveSearch: (query: string) => void;
  onClearHistory: () => void;
  onOpen: (entity: SearchEntity) => void;
}) {
  const frequent = useFrequentEntities(workspaceId, usage);

  if (frequent.pending) {
    return (
      <div role="status" aria-label={m.search_searching()} className="grid gap-2 p-3">
        <Skeleton className="h-9 rounded-lg" />
        <Skeleton className="h-9 rounded-lg" />
        <Skeleton className="h-9 rounded-lg" />
      </div>
    );
  }

  if (history.length === 0 && frequent.entities.length === 0 && !frequent.failed) {
    return (
      <EmptyState
        size="page"
        className="py-10"
        picture={<EmptyIcon icon={SearchLg} />}
        title={channel ? m.search_empty_title_in({ channel }) : m.search_empty_title()}
        description={channel ? m.search_empty_description_in() : m.search_empty_description()}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2 p-2">
      {history.length > 0 && (
        <section aria-labelledby="search-history-heading" className="flex flex-col">
          <div className="flex items-center justify-between gap-2 pr-2">
            <h2 id="search-history-heading" className={SEARCH_HEADING_CLASS}>
              {m.search_history_heading()}
            </h2>
            <Button size="sm" color="link-gray" onPress={onClearHistory}>
              {m.search_history_clear()}
            </Button>
          </div>
          <ul className="flex flex-col">
            {history.map((query) => (
              <li key={query} className="flex items-center">
                <AriaButton
                  data-search-history={query}
                  data-search-option=""
                  className={SEARCH_ROW_CLASS}
                  onPress={() => onSearch(query)}
                >
                  <SearchLg aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
                  <span className="truncate text-sm text-primary">{query}</span>
                </AriaButton>
                <ButtonUtility
                  icon={XClose}
                  size="xs"
                  color="tertiary"
                  tooltip={m.search_history_remove({ query })}
                  aria-label={m.search_history_remove({ query })}
                  onClick={() => onRemoveSearch(query)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="search-frequent-heading" className="flex flex-col">
        <h2 id="search-frequent-heading" className={SEARCH_HEADING_CLASS}>
          {m.search_frequent_heading()}
        </h2>
        {frequent.failed ? (
          <EmptyState
            size="row"
            role="alert"
            title={m.search_frequent_failed()}
            primaryAction={
              <RetryButton size="row" isRetrying={frequent.retrying} onPress={frequent.retry} />
            }
          />
        ) : frequent.entities.length > 0 ? (
          <ul className="flex flex-col">
            {frequent.entities.map((entity) => (
              <li key={`${entity.kind}:${entity.id}`}>
                <SearchEntityRow entity={entity} onOpen={() => onOpen(entity)} />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState size="row" title={m.search_frequent_empty()} />
        )}
      </section>
    </div>
  );
}

function useFrequentEntities(
  workspaceId: string,
  usage: SearchUsage,
): {
  entities: SearchEntity[];
  pending: boolean;
  failed: boolean;
  retrying: boolean;
  retry: () => void;
} {
  const {
    data: directory,
    isPending,
    isError,
    isRefetching,
    refetch,
  } = useQuery(searchDirectoryQuery(workspaceId));
  const entities = useMemo(() => {
    if (!directory) return [];
    const channels = new Map(
      directory.channels
        .filter((channel) => !channel.archived)
        .map((channel) => [channel.id, channel]),
    );
    const agents = new Map(directory.agents.map((agent) => [agent.id, agent]));
    const dms = new Map(
      directory.people.flatMap((person) => (person.dmId ? [[person.dmId, person]] : [])),
    );
    const places = { channel: channels, agent: agents, dm: dms };
    const usable = ({ kind, id }: RememberedEntity) => places[kind].has(id);
    return frequentEntities(usage, Date.now(), usable).map(({ kind, id }): SearchEntity => {
      switch (kind) {
        case "channel":
          return { kind, ...channels.get(id)! };
        case "agent":
          return { kind, ...agents.get(id)! };
        case "dm": {
          const { id: peerId, name, avatarUrl } = dms.get(id)!;
          const label =
            peerId === directory.viewerId ? m.conversation_dm_self_name({ name }) : name;
          return { kind, id, peerId, name: label, avatarUrl };
        }
      }
    });
  }, [directory, usage]);
  const remembered = Object.keys(usage).length > 0;
  return {
    entities,
    pending: remembered && isPending,
    failed: remembered && isError && !directory,
    retrying: isRefetching,
    retry: () => {
      void refetch();
    },
  };
}

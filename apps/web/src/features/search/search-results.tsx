import { ChannelPlace } from "#src/features/conversations/channel-name";
import { actionCardPreviewText } from "#src/features/conversations/action-card-preview";
import { useMemo } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";

import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { conversationAt } from "#src/features/conversations/last-conversation";
import { MessageTextSquare01, SearchLg } from "@untitledui/icons";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#src/components/ui/empty";
import { RelativeTime } from "#src/components/ui/relative-time";
import { Skeleton } from "#src/components/ui/skeleton";
import { conversationSearchWithThread } from "#src/features/conversations/conversation-thread-search";
import { savedJumpTarget } from "#src/features/conversations/saved-messages-model";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { computerLabel } from "#src/features/computers/computer-identity";
import { messagePlainText } from "#src/features/conversations/selection-copy";
import { searchTerms } from "#src/lib/search-terms";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { ActorName, type NamedActor } from "#src/features/avatars/actor-name";
import type { WorkspaceDirectory } from "#src/features/workspaces/workspaces.functions";
import type { MessageSearchHit } from "#src/server/conversations/message-search.server";
import { matchSearchEntities, type SearchEntity } from "./search-entities";
import { SEARCH_HEADING_CLASS, SEARCH_ROW_CLASS, SearchEntityList } from "./search-entity-list";
import { searchEntityKey, type SearchEntityKey } from "./search-memory";
import { SearchMatches } from "./search-matches";
import { SearchTaskList } from "./search-task-list";
import type { SearchFilters } from "./search-filters";
import { messageSearchQuery, searchDirectoryQuery, taskSearchQuery } from "./search-queries";

/**
 * The results of a committed search: the channels, Agents and Computers its query names, then its
 * messages, each opening where it was said.
 */
export function SearchResults({
  workspaceId,
  timeZone,
  query,
  filters,
  onOpen,
  onClear,
}: {
  workspaceId: string;
  timeZone: string | null;
  query: string;
  filters: SearchFilters;
  /** A result is opening: the place it opens, when it is a channel or an Agent. */
  onOpen: (entity: SearchEntityKey | undefined) => void;
  /** Clears the query, or the filters when there is no query. */
  onClear: () => void;
}) {
  const search = useMessageSearch(workspaceId, query, filters, timeZone);
  const { entities, pending: entitiesPending } = useSearchEntities(workspaceId, query);
  const { tasks, pending: tasksPending } = useSearchTasks(workspaceId, query, filters.channelId);
  const refreshing = search.isFetching && !search.isFetchingNextPage;
  const hits = search.data?.pages.flatMap((page) => page.results) ?? [];
  const terms = searchTerms(query);

  // Nothing matched only once both the messages and the Workspace lists have loaded.
  const nothingMatched =
    hits.length === 0 && !search.isPending && !search.isError && !entitiesPending;
  if (nothingMatched && entities.length === 0 && tasks.length === 0 && !tasksPending) {
    return (
      <div className="flex items-start justify-center px-6 py-10">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchLg aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>
              {query ? m.search_no_results_title({ query }) : m.search_no_matching_messages()}
            </EmptyTitle>
            <EmptyDescription>
              {query ? m.search_no_results_description() : m.search_try_different_filters()}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" color="secondary" onClick={onClear}>
              {query ? m.search_clear() : m.search_clear_filters()}
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  return (
    <div className="pb-2" aria-busy={refreshing}>
      {tasks.length > 0 && (
        <SearchTaskList tasks={tasks} terms={terms} onOpen={() => onOpen(undefined)} />
      )}
      {entities.length > 0 && (
        <SearchEntityList
          entities={entities}
          onOpen={(entity) => onOpen(searchEntityKey(entity))}
        />
      )}
      <MessageResults
        workspaceId={workspaceId}
        search={search}
        hits={hits}
        terms={terms}
        clearLabel={query ? m.search_clear() : m.search_clear_filters()}
        onClear={onClear}
        onOpen={onOpen}
      />
    </div>
  );
}

function useMessageSearch(
  workspaceId: string,
  query: string,
  filters: SearchFilters,
  timeZone: string | null,
) {
  return useInfiniteQuery({
    ...messageSearchQuery(workspaceId, query, filters, timeZone),
    // A changed filter keeps the current rows on screen until the new ones arrive.
    placeholderData: keepPreviousData,
  });
}

/** The channels, Computers and Agents the query names; none without a query. */
function useSearchTasks(workspaceId: string, query: string, conversationId: string | undefined) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const here = conversationAt(pathname);
  const currentConversationId =
    here && "channelId" in here ? here.channelId : here && "dmId" in here ? here.dmId : undefined;
  const { data, isPending } = useQuery({
    ...taskSearchQuery(workspaceId, query, conversationId, currentConversationId),
    placeholderData: keepPreviousData,
  });
  // A disabled query still shows its placeholder: without a query there are no Tasks.
  return { tasks: query ? (data ?? []) : [], pending: Boolean(query) && isPending };
}

function useSearchEntities(
  workspaceId: string,
  query: string,
): { entities: SearchEntity[]; pending: boolean } {
  const { data: directory, isPending } = useQuery(searchDirectoryQuery(workspaceId));
  // Built once per directory load; each committed query only filters it.
  const candidates = useMemo<SearchEntity[]>(
    () =>
      directory
        ? [
            ...directory.channels.map((channel) => ({ kind: "channel" as const, ...channel })),
            ...directory.computers.map((computer) => ({
              kind: "computer" as const,
              id: computer.id,
              name: computerLabel(computer),
              hostname: computer.name,
              computerKind: computer.kind,
            })),
            ...directory.agents.map((agent) => ({ kind: "agent" as const, ...agent })),
          ]
        : [],
    [directory],
  );
  const entities = useMemo(
    () => (query ? matchSearchEntities(candidates, query) : []),
    [candidates, query],
  );
  // A failed Workspace list only drops this optional section; it is not "no matches".
  return { entities, pending: Boolean(query) && isPending };
}

/** The Messages section: loading, failure, its rows and Load more. */
function MessageResults({
  workspaceId,
  search,
  hits,
  terms,
  clearLabel,
  onClear,
  onOpen,
}: {
  workspaceId: string;
  search: ReturnType<typeof useMessageSearch>;
  hits: MessageSearchHit[];
  terms: string[];
  /** The way out when no message matches: clear the query, or the filters without one. */
  clearLabel: string;
  onClear: () => void;
  onOpen: (entity: SearchEntityKey | undefined) => void;
}) {
  if (search.isPending) {
    return (
      <div role="status" aria-label={m.search_searching()} className="flex flex-col gap-2 p-3">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-14 rounded-lg" />
        ))}
      </div>
    );
  }

  if (search.isError && hits.length === 0) {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 px-6 py-10 text-center">
        <p className="text-sm font-semibold text-primary">{m.search_failed_title()}</p>
        <p className="max-w-sm text-sm text-tertiary">{m.search_failed_description()}</p>
        <Button size="sm" color="secondary" onClick={() => void search.refetch()}>
          {m.search_retry()}
        </Button>
      </div>
    );
  }

  return (
    <section aria-labelledby="search-messages-heading" className="flex flex-col px-2 pt-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="search-messages-heading" className={SEARCH_HEADING_CLASS}>
          {m.search_messages_heading()}
        </h2>
        {hits.length > 0 && (
          <span role="status" className="px-2 text-xs text-tertiary tabular-nums">
            {search.hasNextPage
              ? m.search_results_count_more({ count: hits.length })
              : m.search_results_count({ count: hits.length })}
          </span>
        )}
      </div>
      {hits.length === 0 && (
        <p className="flex flex-wrap items-center gap-x-2 px-2 py-1 text-sm text-tertiary">
          {m.search_no_messages_match()}
          <Button size="sm" color="link-gray" onClick={onClear}>
            {clearLabel}
          </Button>
        </p>
      )}
      {hits.length > 0 && (
        <ol className="flex flex-col">
          {hits.map((hit) => (
            <SearchResultRow
              key={hit.message.id}
              hit={hit}
              workspaceId={workspaceId}
              terms={terms}
              onOpen={() => onOpen(conversationKey(hit.conversation))}
            />
          ))}
        </ol>
      )}
      {search.isFetchNextPageError && (
        <p role="alert" className="text-center text-sm text-error-primary">
          {m.search_load_more_failed()}
        </p>
      )}
      {search.hasNextPage && (
        <Button
          size="sm"
          color="secondary"
          className="mt-2 self-center"
          isLoading={search.isFetchingNextPage}
          onClick={() => void search.fetchNextPage()}
        >
          {search.isFetchNextPageError ? m.search_retry() : m.search_load_more()}
        </Button>
      )}
    </section>
  );
}

/**
 * Where a result opens in Chat: its conversation at the row that shows the message, and for a
 * thread reply its thread open at the reply, the way Chat opens a thread from Activity.
 */
function messageOpenTarget(
  workspaceSlug: string,
  conversation: MessageSearchHit["conversation"],
  message: MessageSearchHit["message"],
) {
  const target = savedJumpTarget(workspaceSlug, conversation, message);
  return message.threadRootId && "search" in target
    ? {
        ...target,
        search: conversationSearchWithThread(target.search, message.threadRootId),
        hash: `message-${message.id}`,
      }
    : target;
}

/**
 * The remembered place a message result opens: its channel, its direct conversation's Agent (whose
 * card opens that DM), or its direct conversation with a member.
 */
function conversationKey(
  conversation: MessageSearchHit["conversation"],
): SearchEntityKey | undefined {
  if (conversation.channelName) return searchEntityKey({ kind: "channel", id: conversation.id });
  switch (conversation.direct?.kind) {
    case "agent":
      return searchEntityKey({ kind: "agent", id: conversation.direct.agent.id });
    case "people":
      return searchEntityKey({ kind: "dm", id: conversation.id });
    default:
      return undefined;
  }
}

/** Who a direct conversation is with: its Agent, or the member on the other side. */
function directActor(
  direct: MessageSearchHit["conversation"]["direct"],
  directory: WorkspaceDirectory | undefined,
): NamedActor | undefined {
  if (!direct) return undefined;
  if (direct.kind === "agent")
    return {
      kind: "agent",
      id: direct.agent.id,
      name: direct.agent.displayName,
      avatarUrl: directory?.agents.find((agent) => agent.id === direct.agent.id)?.avatarUrl,
    };
  return {
    kind: "user",
    id: direct.peer.id,
    name: direct.peer.displayName,
    avatarUrl: directory?.people.find((person) => person.id === direct.peer.id)?.avatarUrl,
  };
}

function senderActor(message: MessageSearchHit["message"]): NamedActor {
  return {
    kind: message.senderKind === "agent" ? "agent" : "user",
    name: message.senderName,
    avatarUrl: message.senderAvatarUrl,
  };
}

function SearchResultRow({
  hit,
  workspaceId,
  terms,
  onOpen,
}: {
  hit: MessageSearchHit;
  workspaceId: string;
  terms: string[];
  onOpen: () => void;
}) {
  const { conversation, message } = hit;
  const workspaceSlug = useWorkspaceSlug();
  const directory = useQuery(searchDirectoryQuery(workspaceId)).data;
  const place = conversation.channelName ? (
    // Its group avatar and name; a private channel with its lock (tasks #375, #55).
    <ChannelPlace
      id={conversation.id}
      name={conversation.channelName}
      visibility={conversation.visibility}
    />
  ) : (
    // The other side's face before their name (task #521); the picture comes from the directory
    // the search filters already load, as the hit carries only ids and names.
    <ActorName actor={directActor(conversation.direct, directory) ?? senderActor(message)} />
  );
  // An action card's excerpt is written in the viewer's language; it matched on its English body.
  const text =
    actionCardPreviewText(message.card) ||
    (message.body
      ? messagePlainText({ body: message.body, mentions: message.mentions })
      : message.forwarded?.[0]
        ? m.message_forward_preview({ text: message.forwarded[0].sourceBody })
        : (message.attachments[0]?.fileName ?? ""));
  return (
    <li>
      <Link
        {...messageOpenTarget(workspaceSlug, conversation, message)}
        data-search-message-id={message.id}
        data-search-option=""
        onClick={onOpen}
        // A middle click opens a new tab without a click event; it is still an open.
        onAuxClick={(event) => event.button === 1 && onOpen()}
        className={cx(SEARCH_ROW_CLASS, "items-start")}
      >
        <ActorAvatar
          presence={false}
          size="sm"
          src={message.senderAvatarUrl ?? null}
          name={message.senderName}
          alt=""
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-tertiary">
            <span className="truncate font-medium text-primary">{message.senderName}</span>
            <span className="truncate">{place}</span>
            {message.threadRootId && (
              <span className="inline-flex shrink-0 items-center gap-1 text-quaternary">
                <MessageTextSquare01 aria-hidden="true" className="size-3" />
                {m.conversation_thread()}
              </span>
            )}
            {conversation.archived && (
              <Badge size="sm" color="gray" type="modern">
                {m.search_archived()}
              </Badge>
            )}
            <span className="ml-auto shrink-0">
              <RelativeTime value={message.createdAt} />
            </span>
          </div>
          <p className="mt-0.5 line-clamp-2 text-sm break-words text-primary">
            <SearchMatches text={text} terms={terms} />
          </p>
        </div>
      </Link>
    </li>
  );
}

import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertCircle, SearchLg, XClose } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { GalleryWireframe, NoResultsWireframe } from "#src/components/ui/empty-wireframes";
import { Skeleton } from "#src/components/ui/skeleton";
import { m } from "#src/paraglide/messages";
import { loadArtifactGallery } from "./artifact-gallery.functions";
import { GalleryGridCard } from "./artifact-gallery-card";
import {
  AuthorFilter,
  ConversationFilter,
  RelatedToggle,
  SortMenu,
  ViewSwitch,
} from "./artifact-gallery-filters";
import { GalleryList } from "./artifact-gallery-list";
import {
  emptyGalleryState,
  initialFilters,
  useGalleryView,
  type EmptyGalleryState,
  type GalleryFilters,
} from "./artifact-gallery-model";
import { LoadingBody } from "./artifact-page-states";
import { ARTIFACTS_KEY } from "./artifact-queries";

const SEARCH_DEBOUNCE_MS = 250;

const ArtifactPage = lazy(() =>
  import("./artifact-page").then((module) => ({ default: module.ArtifactPage })),
);

function DebouncedSearchInput({
  resetToken,
  onDebouncedChange,
}: {
  resetToken: number;
  onDebouncedChange: (query: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const lastResetRef = useRef(resetToken);
  const lastCommittedRef = useRef("");
  useEffect(() => {
    if (lastResetRef.current !== resetToken) {
      lastResetRef.current = resetToken;
      lastCommittedRef.current = "";
      setTyped("");
      return;
    }
    const next = typed.trim();
    if (next === lastCommittedRef.current) return;
    const timer = setTimeout(() => {
      lastCommittedRef.current = next;
      onDebouncedChange(next);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typed, resetToken, onDebouncedChange]);
  return (
    <div className="w-full sm:w-64">
      <Input
        size="sm"
        icon={SearchLg}
        aria-label={m.ag_search_aria()}
        placeholder={m.ag_search()}
        value={typed}
        onChange={setTyped}
      />
    </div>
  );
}

function useGallery(filters: GalleryFilters) {
  const { query, scope, authorAgentIds, related, sort } = filters;
  return useInfiniteQuery({
    queryKey: [...ARTIFACTS_KEY, "gallery", filters],
    queryFn: ({ pageParam }) =>
      loadArtifactGallery({
        data: {
          sort,
          ...(query ? { query } : {}),
          ...(scope ? { scope } : {}),
          ...(authorAgentIds.length > 0 ? { authorAgentIds } : {}),
          ...(related ? { related } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 30_000,
  });
}

export function ArtifactGalleryPage({
  openArtifactId,
  version,
  commentId,
  reviewId,
  arrival,
  onCloseArtifact,
  onClearReview,
}: {
  openArtifactId?: string | undefined;
  version?: number | undefined;
  commentId?: string | undefined;
  reviewId?: string | undefined;
  arrival?: string | undefined;
  onCloseArtifact?: (() => void) | undefined;
  onClearReview?: (() => void) | undefined;
} = {}) {
  const [filters, setFilters] = useState<GalleryFilters>(initialFilters);
  const [resetToken, setResetToken] = useState(0);
  const [view, setView] = useGalleryView();
  const handleQueryChange = useCallback((query: string) => {
    setFilters((previous) => (previous.query === query ? previous : { ...previous, query }));
  }, []);
  const update = (patch: Partial<GalleryFilters>) =>
    setFilters((previous) => ({ ...previous, ...patch }));
  const gallery = useGallery(filters);
  const cards = gallery.data?.pages.flatMap((page) => page.artifacts) ?? [];
  const emptyState = emptyGalleryState(filters);
  const clearAll = () => {
    setResetToken((count) => count + 1);
    setFilters((previous) => ({ ...initialFilters, sort: previous.sort }));
  };
  const overlayOpen = Boolean(openArtifactId && onCloseArtifact);
  const countLabel =
    !gallery.isPending && cards.length > 0
      ? gallery.hasNextPage
        ? m.ag_count_more({ count: cards.length })
        : m.ag_count({ count: cards.length })
      : null;

  return (
    <main className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-primary">
      <div
        inert={overlayOpen || undefined}
        aria-hidden={overlayOpen || undefined}
        className="flex min-h-0 flex-1 flex-col"
      >
        <header className="flex shrink-0 flex-col gap-3 border-b border-secondary px-page py-3">
          <div className="flex items-baseline gap-2.5">
            <h1 className="text-lg font-semibold text-primary">{m.ag_title()}</h1>
            {countLabel && <span className="text-sm text-tertiary tabular-nums">{countLabel}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DebouncedSearchInput resetToken={resetToken} onDebouncedChange={handleQueryChange} />
            <ConversationFilter scope={filters.scope} onChange={(scope) => update({ scope })} />
            <AuthorFilter
              authorIds={filters.authorAgentIds}
              onChange={(authorAgentIds) => update({ authorAgentIds })}
            />
            <RelatedToggle on={filters.related} onChange={(related) => update({ related })} />
            <span className="flex-1" />
            <SortMenu sort={filters.sort} onChange={(sort) => update({ sort })} />
            <ViewSwitch view={view} onChange={setView} />
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-page py-4">
          {gallery.isPending ? (
            <Loading />
          ) : gallery.isError && cards.length === 0 ? (
            <EmptyState
              size="page"
              role="alert"
              picture={<EmptyIcon icon={AlertCircle} />}
              title={m.empty_artifacts_load_failed_title()}
              description={m.empty_load_failed_safe()}
              primaryAction={
                <RetryButton
                  size="page"
                  isRetrying={gallery.isRefetching}
                  onPress={() => void gallery.refetch()}
                />
              }
            />
          ) : cards.length === 0 ? (
            <EmptyGallery
              state={emptyState}
              query={filters.query.trim()}
              onClear={clearAll}
              onSeeAll={() => update({ related: false })}
            />
          ) : (
            <>
              {view === "grid" ? (
                <div className="grid grid-cols-1 gap-3 min-[24rem]:grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(15.5rem,1fr))]">
                  {cards.map((card) => (
                    <GalleryGridCard key={card.id} card={card} sort={filters.sort} />
                  ))}
                </div>
              ) : (
                <GalleryList cards={cards} sort={filters.sort} />
              )}
              {gallery.hasNextPage && (
                <div className="mt-4 flex flex-col items-center gap-2">
                  <Button
                    size="sm"
                    color="secondary"
                    isLoading={gallery.isFetchingNextPage}
                    onPress={() => void gallery.fetchNextPage()}
                  >
                    {m.ag_load_more()}
                  </Button>
                  {gallery.isFetchNextPageError && (
                    <p role="alert" className="text-sm text-error-primary">
                      {m.ag_more_failed()}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {openArtifactId && onCloseArtifact && (
        <div className="absolute inset-0 z-20 flex min-h-0 flex-col bg-primary">
          <Suspense fallback={<LoadingBody />}>
            <ArtifactPage
              artifactId={openArtifactId}
              overlay={{ onClose: onCloseArtifact }}
              version={version}
              commentId={commentId}
              reviewId={reviewId}
              arrival={arrival}
              onClearReview={onClearReview}
            />
          </Suspense>
        </div>
      )}
    </main>
  );
}

function Loading() {
  return (
    <div className="grid grid-cols-1 gap-3 min-[24rem]:grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(15.5rem,1fr))]">
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} className="h-56 rounded-xl" />
      ))}
    </div>
  );
}

function EmptyGallery({
  state,
  query,
  onClear,
  onSeeAll,
}: {
  state: EmptyGalleryState;
  query: string;
  onClear: () => void;
  onSeeAll: () => void;
}) {
  if (state.kind === "empty") {
    return (
      <EmptyState
        size="page"
        picture={<GalleryWireframe />}
        title={m.ag_empty()}
        description={m.empty_artifacts_description()}
      />
    );
  }
  if (state.kind === "empty-related") {
    return (
      <EmptyState
        size="page"
        live="polite"
        picture={<NoResultsWireframe />}
        title={m.ag_empty_related()}
        description={m.empty_artifacts_no_match_description()}
        primaryAction={
          <Button size="sm" color="secondary" onPress={onSeeAll}>
            {m.ag_see_all()}
          </Button>
        }
      />
    );
  }
  const title =
    state.kind === "no-match-search" && query
      ? m.empty_artifacts_no_match_query({ query })
      : state.kind === "no-match-search"
        ? m.ag_no_match_search()
        : m.ag_no_match_filters();
  return (
    <EmptyState
      size="page"
      live="polite"
      picture={<NoResultsWireframe />}
      title={title}
      description={m.empty_artifacts_no_match_description()}
      primaryAction={
        <Button size="sm" color="secondary" iconLeading={XClose} onPress={onClear}>
          {state.kind === "no-match-search" && state.clearKind === "search"
            ? m.ag_clear_search()
            : m.ag_clear_filters()}
        </Button>
      }
      secondaryAction={
        state.kind === "no-match-filters" && state.showSeeAll ? (
          <Button size="sm" color="tertiary" onPress={onSeeAll}>
            {m.ag_see_all()}
          </Button>
        ) : undefined
      }
    />
  );
}

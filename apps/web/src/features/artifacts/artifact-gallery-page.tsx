import { useEffect, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { SearchLg, XClose } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
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
import { ArtifactIcon } from "./artifact-parts";
import { ARTIFACTS_KEY } from "./artifact-queries";
import { useScopeOf } from "./artifact-scope";

const SEARCH_DEBOUNCE_MS = 250;

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

export function ArtifactGalleryPage() {
  const [filters, setFilters] = useState<GalleryFilters>(initialFilters);
  const [typed, setTyped] = useState("");
  const [view, setView] = useGalleryView();
  const scopeOf = useScopeOf();
  useEffect(() => {
    const timer = setTimeout(
      () => setFilters((previous) => ({ ...previous, query: typed.trim() })),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [typed]);
  const update = (patch: Partial<GalleryFilters>) =>
    setFilters((previous) => ({ ...previous, ...patch }));
  const gallery = useGallery(filters);
  const cards = gallery.data?.pages.flatMap((page) => page.artifacts) ?? [];
  const emptyState = emptyGalleryState(filters);
  const clearAll = () => {
    setTyped("");
    setFilters({ ...initialFilters, sort: filters.sort });
  };
  return (
    <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-primary">
      <header className="flex shrink-0 flex-col gap-3 border-b border-secondary px-4 py-3 sm:px-6">
        <h1 className="text-lg font-semibold text-primary">{m.ag_title()}</h1>
        <div className="flex flex-wrap items-center gap-2">
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
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        {gallery.isPending ? (
          <Loading />
        ) : gallery.isError && cards.length === 0 ? (
          <Notice title={m.ag_error()}>
            <Button size="sm" color="secondary" onClick={() => void gallery.refetch()}>
              {m.ag_retry()}
            </Button>
          </Notice>
        ) : cards.length === 0 ? (
          <EmptyGallery
            state={emptyState}
            onClear={clearAll}
            onSeeAll={() => update({ related: false })}
          />
        ) : (
          <>
            {view === "grid" ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(15.5rem,1fr))]">
                {cards.map((card) => (
                  <GalleryGridCard
                    key={card.id}
                    card={card}
                    sort={filters.sort}
                    scope={scopeOf(card)}
                  />
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
                  onClick={() => void gallery.fetchNextPage()}
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
    </main>
  );
}

function Loading() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(15.5rem,1fr))]">
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} className="h-56 rounded-xl" />
      ))}
    </div>
  );
}

function Notice({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <ArtifactIcon entryPath="index.html" />
      <p className="text-sm font-medium text-secondary">{title}</p>
      {children}
    </div>
  );
}

function EmptyGallery({
  state,
  onClear,
  onSeeAll,
}: {
  state: EmptyGalleryState;
  onClear: () => void;
  onSeeAll: () => void;
}) {
  if (state.kind === "empty") return <Notice title={m.ag_empty()} />;
  if (state.kind === "empty-related")
    return (
      <Notice title={m.ag_empty_related()}>
        <Button size="sm" color="link-color" onClick={onSeeAll}>
          {m.ag_see_all()}
        </Button>
      </Notice>
    );
  return (
    <Notice
      title={state.kind === "no-match-search" ? m.ag_no_match_search() : m.ag_no_match_filters()}
    >
      {state.kind === "no-match-filters" && state.showSeeAll && (
        <Button size="sm" color="link-color" onClick={onSeeAll}>
          {m.ag_see_all()}
        </Button>
      )}
      <Button size="sm" color="secondary" iconLeading={XClose} onClick={onClear}>
        {state.kind === "no-match-search" && state.clearKind === "search"
          ? m.ag_clear_search()
          : m.ag_clear_filters()}
      </Button>
    </Notice>
  );
}

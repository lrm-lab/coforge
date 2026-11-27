import { useState } from "react";

export type GalleryView = "grid" | "list";
export type GallerySort = "opened" | "updated";
export type GalleryStatus = "unsettled" | "all" | "settled";
export type GalleryScope =
  | { kind: "conversation"; conversationId: string }
  | { kind: "workspace" }
  | { kind: "link" };

export type GalleryFilters = {
  query: string;
  scope: GalleryScope | undefined;
  authorAgentIds: string[];
  status: GalleryStatus;
  related: boolean;
  sort: GallerySort;
};

export const initialFilters: GalleryFilters = {
  query: "",
  scope: undefined,
  authorAgentIds: [],
  status: "unsettled",
  related: false,
  sort: "opened",
};

export type EmptyGalleryState =
  | { kind: "empty" }
  | { kind: "empty-related" }
  | { kind: "no-match-search"; clearKind: "search" | "filters" }
  | { kind: "no-match-filters"; showSeeAll: boolean };

export function emptyGalleryState(filters: GalleryFilters): EmptyGalleryState {
  const searching = filters.query !== "";
  const narrowed = filters.scope !== undefined || filters.authorAgentIds.length > 0;
  if (!searching && !narrowed)
    return filters.related ? { kind: "empty-related" } : { kind: "empty" };
  if (searching)
    return {
      kind: "no-match-search",
      clearKind: narrowed || filters.related ? "filters" : "search",
    };
  return { kind: "no-match-filters", showSeeAll: filters.related };
}

export function isGalleryCardDimmed(card: { settled: unknown }, status: GalleryStatus): boolean {
  return status === "all" && card.settled !== null && card.settled !== undefined;
}

export function filterGalleryByStatus<
  T extends { settled: unknown; mentionsYou: boolean; newComments: number },
>(cards: readonly T[], status: GalleryStatus) {
  if (status === "all") {
    const dimmedSettledCount = cards.filter((card) => isGalleryCardDimmed(card, status)).length;
    return {
      visible: [...cards],
      hiddenSettledCount: 0,
      dimmedSettledCount,
    };
  }
  if (status === "settled") {
    const visible = cards.filter((card) => card.settled !== null && card.settled !== undefined);
    return {
      visible,
      hiddenSettledCount: 0,
      dimmedSettledCount: 0,
    };
  }
  const visible = cards.filter(
    (card) =>
      card.settled === null ||
      card.settled === undefined ||
      card.mentionsYou ||
      card.newComments > 0,
  );
  return {
    visible,
    hiddenSettledCount: cards.length - visible.length,
    dimmedSettledCount: 0,
  };
}

const VIEW_KEY = "coforge:artifacts:view";

function readView(): GalleryView {
  if (typeof window === "undefined") return "grid";
  try {
    return window.localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

export function useGalleryView(): [GalleryView, (view: GalleryView) => void] {
  const [view, setView] = useState<GalleryView>(readView);
  return [
    view,
    (next) => {
      setView(next);
      try {
        window.localStorage.setItem(VIEW_KEY, next);
      } catch {
        return;
      }
    },
  ];
}

import { useState } from "react";

export type GalleryView = "grid" | "list";
export type GallerySort = "opened" | "updated";
export type GalleryScope =
  | { kind: "conversation"; conversationId: string }
  | { kind: "workspace" }
  | { kind: "link" };

export type GalleryFilters = {
  query: string;
  scope: GalleryScope | undefined;
  authorAgentIds: string[];
  related: boolean;
  sort: GallerySort;
};

export const initialFilters: GalleryFilters = {
  query: "",
  scope: undefined,
  authorAgentIds: [],
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

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

export const hasFilters = (filters: GalleryFilters) =>
  filters.scope !== undefined || filters.authorAgentIds.length > 0 || filters.related;

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

import { createContext, useContext } from "react";

import type { SearchFilters } from "./search-filters";

/** What the search dialog opens with; nothing opens it on the viewer's history. */
export type SearchIntent = {
  query?: string;
  filters?: SearchFilters;
  /** The filters alone wait for a query ("Search this channel"). */
  deferred?: boolean;
};

export const OpenSearchContext = createContext<(intent?: SearchIntent) => void>(() => {});

/** Opens the Workspace search dialog over the current page. */
export function useOpenSearch() {
  return useContext(OpenSearchContext);
}

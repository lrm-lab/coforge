import { createContext, useContext } from "react";

import type { SharedRect } from "#src/lib/shared-element-rect";
import type { SearchFilters } from "./search-filters";

export type SearchIntent = {
  query?: string;
  filters?: SearchFilters;
  deferred?: boolean;
  originRect?: SharedRect | null;
  source?: "pointer" | "keyboard";
};

export const OpenSearchContext = createContext<(intent?: SearchIntent) => void>(() => {});

export function useOpenSearch() {
  return useContext(OpenSearchContext);
}

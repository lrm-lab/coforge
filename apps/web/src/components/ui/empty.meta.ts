import type { ComponentMeta } from "#src/components/ui/component-meta";
import { DURATION_MS } from "#src/utils/motion-tokens";

export const emptyMeta: ComponentMeta = {
  component: "EmptyState",
  category: "state",
  whenToUse: [
    "Settled zero-data, zero-search-results, no-permission, or load-failure states inside a page, card, list row, or menu",
    "Choose size='page' | 'card' | 'row' | 'menu' to match the surrounding container",
  ],
  whenNotToUse: [
    {
      when: "Initial data fetch is still in flight and has not settled",
      why: "Showing an empty state before the query settles flashes false emptiness before content arrives",
      instead: "Render Skeleton matching final layout or route pending fallback",
    },
    {
      when: "A full-page standalone error route with no app shell (such as 404)",
      why: "Full-page standalone routes use the official Untitled application/empty-state layout",
      instead: "components/application/empty-state",
    },
  ],
  motion: {
    enterMs: DURATION_MS.md,
    exitMs: DURATION_MS.mdOut,
    transform: "6px vertical slide + fade (empty-state-enter)",
    reducedMotion: "fade-only",
  },
  accessibility: [
    "Announces zero-result search outcomes via a polite live region",
    "Distinguishes empty data, zero matches, permission denial, and load failure with RetryButton",
  ],
  limits: {
    showWhilePendingAllowed: false,
  },
};

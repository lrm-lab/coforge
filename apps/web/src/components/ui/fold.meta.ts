import type { ComponentMeta } from "#src/components/ui/component-meta";
import { DURATION_MS } from "#src/utils/motion-tokens";

export const foldMeta: ComponentMeta = {
  component: "Fold",
  category: "motion",
  whenToUse: [
    "Interruptible height collapse and expand (dismissed notice cards, answered action cards, inline expandable sections)",
    "Animates grid-template-rows (0fr <-> 1fr) and opacity so siblings below slide smoothly instead of jumping",
  ],
  whenNotToUse: [
    {
      when: "Animating raw height or arbitrary max-height values in CSS",
      why: "Hardcoded max-height lags on exit and breaks timing when content height varies",
      instead: "Fold (components/ui/fold.tsx)",
    },
    {
      when: "Hiding a large off-screen panel or dialog",
      why: "Dialogs and drawers should unmount or portal rather than collapsing layout height",
      instead: "ModalOverlay or Popover",
    },
  ],
  motion: {
    enterMs: DURATION_MS.md,
    exitMs: DURATION_MS.mdOut,
    transform: "grid-template-rows 0fr <-> 1fr + opacity",
    reducedMotion: "instant",
  },
  accessibility: [
    "Sets inert={!open} while folded so collapsed controls cannot trap keyboard focus",
    "Uses overflow-clip with overflow-clip-margin so edge focus rings stay visible",
  ],
  limits: {
    inertWhenClosed: true,
  },
};

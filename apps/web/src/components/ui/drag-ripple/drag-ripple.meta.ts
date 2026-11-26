import type { ComponentMeta } from "#src/components/ui/component-meta";

export const dragRippleMeta: ComponentMeta = {
  component: "DragRipple",
  category: "motion",
  whenToUse: [
    "Reorderable horizontal tab strips, vertical sidebar directories, and report page tabs over dnd-kit",
    "Lifts the dragged item, collapses its origin slot, draws an insertion line, leans neighbor items by distance, and springs into place on drop",
  ],
  whenNotToUse: [
    {
      when: "Building a bespoke dnd-kit reorder list with custom layout-thrashing margin/padding animations",
      why: "DragRipple keeps all displacement transform-only and consistent across reorderable lists",
      instead: "DragRipple (components/ui/drag-ripple/) or ReorderableTabStrip",
    },
    {
      when: "Lists that do not support manual user reordering",
      why: "Drag affordances and listeners add overhead where order is system-defined",
      instead: "Plain semantic list",
    },
  ],
  motion: {
    spring: "lift (0.18s, bounce 0.4); settle (0.3s, bounce 0.1)",
    transform: "GPU translate3d displacement + insertion line",
    reducedMotion: "insertion-line-only",
  },
  accessibility: [
    "Retains keyboard drag-and-drop coordinate navigation",
    "Shows only the static insertion line when prefers-reduced-motion is enabled",
  ],
  limits: {
    transformOnlyDisplacement: true,
    settleTimeoutMs: 3000,
  },
};

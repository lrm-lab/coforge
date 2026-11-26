import type { ComponentMeta } from "#src/components/ui/component-meta";
import { DURATION_MS } from "#src/utils/motion-tokens";

export const selectionActionBarMeta: ComponentMeta = {
  component: "SelectionActionBar",
  category: "control",
  whenToUse: [
    "Floating bottom bulk-selection toolbar for multi-select lists (messages, artifacts, tasks, inbox)",
    "Built on React Aria Toolbar and Separator with concentric pill geometry and monochrome batch actions",
  ],
  whenNotToUse: [
    {
      when: "Hand-rolling a native <div role='toolbar'> for batch actions",
      why: "Native role='toolbar' lacks React Aria roving focus and arrow-key navigation (coforge/no-handrolled-toolbar)",
      instead: "SelectionActionBar or React Aria Toolbar",
    },
    {
      when: "Single-item inline hover actions on one row",
      why: "Floating bottom bulk bars are reserved for explicit multi-selection mode",
      instead: "Row-scoped action bar or Dropdown menu",
    },
  ],
  motion: {
    enterMs: DURATION_MS.sm,
    exitMs: DURATION_MS.smOut,
    transform: "6px rise + scale(0.985 -> 1) with backwards fill-mode (selection-bar-enter)",
    reducedMotion: "fade-only",
  },
  accessibility: [
    "Provides a single tab stop with arrow-key navigation via React Aria Toolbar",
    "Uses semantic --color-selection-bar-* tokens with light and dark pairs",
  ],
  limits: {
    requiresReactAriaToolbar: true,
  },
};

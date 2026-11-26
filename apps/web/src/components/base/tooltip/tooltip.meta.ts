import type { ComponentMeta } from "#src/components/ui/component-meta";
import { LABEL_COOLDOWN_MS, LABEL_OPEN_DELAY_MS } from "#src/lib/hover-intent";

export const tooltipMeta: ComponentMeta = {
  component: "Tooltip",
  overlayKind: "label",
  whenToUse: [
    "Short text labels for icon-only buttons, keyboard shortcuts, truncated text, exact timestamps, and chart values",
    "Wrapped in <TooltipGroup> inside toolbars, icon rails, swatch grids, reaction rows, and charts so sibling labels swap in place without flicker",
  ],
  whenNotToUse: [
    {
      when: "The overlay contains any button, link, or interactive control",
      why: "Tooltips are pointer-events-none labels that hide immediately on leave and cannot be interacted with",
      instead: "HoverPopover (Card) for hover peeks with actions, or DialogTrigger / Popover on click",
    },
    {
      when: "A caller wants a faster custom delay like delay={120}",
      why: "Per-site delays break toolbar sweep protection and make hover behavior inconsistent across views",
      instead: "Use Tooltip defaults (500ms) and wrap adjacent triggers in <TooltipGroup>",
    },
    {
      when: "Essential information or instructions on touch-first screens",
      why: "Touch devices have no hover; critical text hidden inside a tooltip is unreachable",
      instead: "Render visible helper text inline or open a Popover / Dialog on tap",
    },
  ],
  timing: {
    openDelayMs: LABEL_OPEN_DELAY_MS,
    closeDelayMs: 0,
    cooldownMs: LABEL_COOLDOWN_MS,
  },
  motion: {
    enterMs: 140,
    exitMs: 60,
    reducedMotion: "fade-only",
  },
  limits: {
    interactiveContentAllowed: false,
    overrideDelayAllowed: false,
    groupWrapRecommendedForSiblingCount: 2,
  },
};

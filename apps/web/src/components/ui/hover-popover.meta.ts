import type { ComponentMeta } from "#src/components/ui/component-meta";
import {
  CARD_CLOSE_DELAY_MS,
  CARD_OPEN_DELAY_MS,
  CARD_SWAP_SLOW_MS,
  POINTER_FAST_THRESHOLD_PX_PER_MS,
  POINTER_SPEED_WINDOW_MS,
} from "#src/lib/hover-intent";

export const hoverPopoverMeta: ComponentMeta = {
  component: "HoverPopover",
  overlayKind: "card",
  whenToUse: [
    "Medium profile or entity peek cards (Agent, Person, Task) that cover surrounding content or contain clickable links/buttons",
    "Wrapped in <HoverCardGroup> inside avatar rows, member rosters, and message streams so resting on a sibling swaps content in place",
  ],
  whenNotToUse: [
    {
      when: "The overlay is read-only short text with nothing to click (such as reaction names or truncated labels)",
      why: "Card delays and gap bridges add unnecessary weight to simple labels",
      instead: "Tooltip + TooltipGroup",
    },
    {
      when: "The overlay's primary job is performing an action, choosing from a menu, or typing into an input",
      why: "Hover-opened panels close unexpectedly when the pointer drifts and steal focus during typing",
      instead: "Click-opened Dropdown or DialogTrigger / Popover",
    },
  ],
  timing: {
    openDelayMs: CARD_OPEN_DELAY_MS,
    closeDelayMs: CARD_CLOSE_DELAY_MS,
    swapSlowMs: CARD_SWAP_SLOW_MS,
    pointerSpeedWindowMs: POINTER_SPEED_WINDOW_MS,
    pointerFastThresholdPxPerMs: POINTER_FAST_THRESHOLD_PX_PER_MS,
  },
  motion: {
    enterMs: 200,
    exitMs: 120,
    swapMs: 200,
    transform: "4px drop along placement axis",
    reducedMotion: "fade-only",
  },
  limits: {
    fullWidthGapBridgeRequired: true,
    overrideDelayAllowed: false,
  },
};

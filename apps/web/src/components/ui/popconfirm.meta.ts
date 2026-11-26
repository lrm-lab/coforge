import type { ComponentMeta } from "#src/components/ui/component-meta";
import { DURATION_MS } from "#src/utils/motion-tokens";

export const popconfirmMeta: ComponentMeta = {
  component: "Popconfirm",
  category: "dialog",
  whenToUse: [
    "Second check for an irreversible change to a single item owned by the current user, anchored directly to the trigger button",
    "Dual-state controls (Start/Stop) via isDisabled so the trigger keeps keyboard focus when confirmation is not needed",
  ],
  whenNotToUse: [
    {
      when: "The change affects other people, acts on multiple items, or requires choosing options first",
      why: "High-impact or multi-decision confirmations need centered modal focus and consequence space",
      instead: "ConfirmDialog (components/ui/confirm-dialog.tsx)",
    },
    {
      when: "The action is reversible",
      why: "Reversible changes should run immediately with Undo rather than gating behind a confirmation popover",
      instead: "useAppToast().undoable()",
    },
  ],
  motion: {
    enterMs: DURATION_MS.sm,
    exitMs: DURATION_MS.smOut,
    transform: "origin-aware scale+fade on desktop popover; bottom confirmation sheet on phone",
    reducedMotion: "fade-only",
  },
  accessibility: [
    "Restores focus to trigger on dismiss, or to caller fallbackFocus container when confirming removes the trigger",
    "Switches automatically to a bottom confirmation sheet on phone viewports",
  ],
  limits: {
    dismissibleWhileRunning: false,
    maxConsequenceLines: 1,
  },
};

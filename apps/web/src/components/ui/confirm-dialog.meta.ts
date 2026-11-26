import type { ComponentMeta } from "#src/components/ui/component-meta";
import { DURATION_MS } from "#src/utils/motion-tokens";

export const confirmDialogMeta: ComponentMeta = {
  component: "ConfirmDialog",
  category: "dialog",
  whenToUse: [
    "Irreversible actions that affect other workspace members, act in bulk, or require reading consequences before deciding",
    "Destructive operations that need inline refusal messages and a non-dismissible running state",
  ],
  whenNotToUse: [
    {
      when: "Confirming a single irreversible action on an item only the viewer owns (stop one Agent, delete own template)",
      why: "A full centered dialog interrupts surrounding context for a local action",
      instead: "Popconfirm (components/ui/popconfirm.tsx)",
    },
    {
      when: "The action can be undone immediately without data loss (close chat, unsave message, clear notes)",
      why: "Reversible actions should execute immediately rather than adding confirmation friction",
      instead: "Execute immediately with useAppToast().undoable()",
    },
    {
      when: "Using browser window.confirm() or window.alert()",
      why: "Native browser dialogs block the JS thread, ignore theme/locale, and fail accessibility",
      instead: "ConfirmDialog or Popconfirm",
    },
  ],
  motion: {
    enterMs: DURATION_MS.md,
    exitMs: DURATION_MS.mdOut,
    reducedMotion: "fade-only",
  },
  accessibility: [
    "Confirm button receives initial focus so a fresh Enter confirms while HeldEnterGuard drops held-key repeats",
    "Cannot be dismissed via Escape, outside click, or close button while the mutation is running",
  ],
  limits: {
    dismissibleWhileRunning: false,
    requiresHeldEnterGuard: true,
  },
};

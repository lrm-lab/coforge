import type { ComponentMeta } from "#src/components/ui/component-meta";
import { DURATION_MS } from "#src/utils/motion-tokens";

export const unsavedChangesDialogMeta: ComponentMeta = {
  component: "UnsavedChangesDialog",
  category: "dialog",
  whenToUse: [
    "Guarding a form overlay, side pane, or full-page form against accidental loss of unsaved edits via useUnsavedChangesGuard",
    "Paired with TanStack Router useBlocker on full-page or side-pane editors",
  ],
  whenNotToUse: [
    {
      when: "The form is clean (no dirty edits)",
      why: "Closing an untouched form must succeed immediately without prompting",
      instead: "Close directly through useUnsavedChangesGuard with dirty={false}",
    },
    {
      when: "Confirming a destructive deletion rather than discarding unsaved form input",
      why: "Unsaved-changes copy and Save-and-Close semantics do not fit destructive deletes",
      instead: "ConfirmDialog or Popconfirm",
    },
  ],
  motion: {
    enterMs: DURATION_MS.md,
    exitMs: DURATION_MS.mdOut,
    reducedMotion: "fade-only",
  },
  accessibility: [
    "Routes Escape, outside click, close button, and Cancel through one requestClose guard",
    "Focuses the primary filled action (Save and Close when onSave is provided, else Discard)",
  ],
  limits: {
    showSaveActionOnlyWhenOnSaveProvided: true,
  },
};

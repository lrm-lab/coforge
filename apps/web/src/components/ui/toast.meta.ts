import type { ComponentMeta } from "#src/components/ui/component-meta";
import { ACTION_TOAST_MS, RESULT_TOAST_MS } from "#src/components/ui/toast-model";
import { DURATION_MS } from "#src/utils/motion-tokens";

export const toastMeta: ComponentMeta = {
  component: "AppToastProvider",
  category: "feedback",
  whenToUse: [
    "Single-line transient confirmation after a user-initiated action (saved, copied, moved)",
    "Immediate execution with an Undo countdown ring via undoable(), or a single Open / immediate follow-up action",
    "Cross-navigation progress pill via progress() that resolves in place to the final result",
  ],
  whenNotToUse: [
    {
      when: "An error the user must see, fix, retry, or still find after navigating back (validation, failed send, offline Computer)",
      why: "Toasts auto-dismiss and disappear across context switches",
      instead: "Inline Alert or field-adjacent error copy",
    },
    {
      when: "System-wide asynchronous events (new version available, background job finished, billing/security)",
      why: "System events are not confirmations of a just-completed user click",
      instead: "appNotice / NoticeCard (components/ui/notice-card.tsx)",
    },
    {
      when: "The same feedback is already shown inline in the affected area",
      why: "Never show the same result in both an inline state and a toast simultaneously",
      instead: "Keep only the inline state",
    },
  ],
  timing: {
    statusDurationMs: RESULT_TOAST_MS,
    actionDurationMs: ACTION_TOAST_MS,
  },
  motion: {
    enterMs: DURATION_MS.sm,
    exitMs: DURATION_MS.smOut,
    reducedMotion: "fade-only",
  },
  accessibility: [
    "Never steals focus on appear; F6 jumps into the notification region",
    "Pauses countdown on pointer hover, focus within, or hidden tab; Escape and horizontal swipe dismiss",
    "Never exposes raw error codes or wire strings",
  ],
  limits: {
    maxVisibleAtOnce: 1,
    maxQueued: 3,
    maxActionsPerToast: 1,
    rawErrorCodesAllowed: false,
  },
};

import type { ComponentMeta } from "#src/components/ui/component-meta";
import { DURATION_MS } from "#src/utils/motion-tokens";

export const modalMeta: ComponentMeta = {
  component: "ModalOverlay",
  category: "dialog",
  whenToUse: [
    "Full-screen phone form dialogs using role='page' so mobile joins document flow for iOS Safari keyboard avoidance and toolbar sampling while desktop stays centered",
    "Destructive confirmations using role='confirmation' so phones render a swipe-to-dismiss bottom sheet with stacked full-width actions",
    "High-frequency keyboard-triggered dialogs (Search, Keyboard Shortcuts) using instant to remove enter/exit delay",
  ],
  whenNotToUse: [
    {
      when: "Confirming a single self-owned irreversible action with no extra form input",
      why: "Full modals interrupt surrounding context more than necessary on desktop",
      instead: "Popconfirm (components/ui/popconfirm.tsx)",
    },
    {
      when: "Displaying a non-blocking hover peek or contextual action menu",
      why: "Modals trap focus and dim the page",
      instead: "HoverPopover or Dropdown",
    },
    {
      when: "Using Untitled UI's raw application/modals ModalOverlay directly in feature code",
      why: "Raw fixed inset-0 overlays break iOS Safari keyboard avoidance and Safari 26+ toolbar tinting",
      instead: "ModalOverlay and Modal from components/ui/modal.tsx",
    },
  ],
  motion: {
    enterMs: DURATION_MS.md,
    exitMs: DURATION_MS.mdOut,
    transform:
      "centered scale/fade on desktop; bottom sheet slide on phone confirmation; zero motion when instant",
    reducedMotion: "fade-only",
  },
  accessibility: [
    "Preserves single mounted subtree across sm breakpoint so form state survives resize/rotation",
    "Bottom sheet grabber meets 44px coarse hit target and routes swipe dismissal through overlay close guard",
  ],
  limits: {
    preserveSubtreeAcrossBreakpoint: true,
    phoneConfirmationSheetGrabberPx: 44,
  },
};

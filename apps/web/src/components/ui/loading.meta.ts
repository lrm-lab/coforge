import type { ComponentMeta } from "#src/components/ui/component-meta";
import {
  BUTTON_LOADING_EXIT_DURATION_MS,
  BUTTON_LOADING_MIN_VISIBLE_MS,
  BUTTON_LOADING_SHOW_DELAY_MS,
} from "#src/components/ui/loading";
import { DURATION_MS } from "#src/utils/motion-tokens";

export const loadingMeta: ComponentMeta = {
  component: "ButtonLoadingTransition",
  category: "motion",
  whenToUse: [
    "In-control busy spinners (Button isLoading and inline progress indicators) via useLoadingVisible / useButtonLoadingTransition",
    "Prevents display inertia by hiding spinners on sub-150ms actions and holding visible spinners for at least 400ms",
  ],
  whenNotToUse: [
    {
      when: "Route-level or whole-view loading skeletons",
      why: "Route transitions use the longer 300ms/300ms router pending policy in lib/pending-policy.ts",
      instead: "Router defaultPendingMs / defaultPendingMinMs (lib/pending-policy.ts)",
    },
    {
      when: "Rendering Untitled UI LoadingIndicator inside a button or inline text row",
      why: "Untitled LoadingIndicator starts at 32px in a column layout",
      instead: "Spinner from components/ui/spinner.tsx",
    },
  ],
  timing: {
    showDelayMs: BUTTON_LOADING_SHOW_DELAY_MS,
    minVisibleMs: BUTTON_LOADING_MIN_VISIBLE_MS,
  },
  motion: {
    enterMs: DURATION_MS.sm,
    exitMs: BUTTON_LOADING_EXIT_DURATION_MS,
    transform: "0.5rem vertical label/spinner swap with locked button width",
    reducedMotion: "fade-only",
  },
  limits: {
    immediateReleaseOnContentOrIntentChange: true,
  },
};

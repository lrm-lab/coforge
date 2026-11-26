import type { ComponentMeta } from "#src/components/ui/component-meta";

export const alertMeta: ComponentMeta = {
  component: "Alert",
  category: "feedback",
  whenToUse: [
    "Persistent inline errors, warnings, or status notices that remain visible inside the affected panel or form until resolved",
    "Refusal explanations with optional recovery actions and dismiss control",
  ],
  whenNotToUse: [
    {
      when: "Brief confirmation of a completed action that needs no follow-up",
      why: "Inline banners add visual weight for transient confirmations",
      instead: "useAppToast() (components/ui/toast.tsx)",
    },
    {
      when: "A full empty state with no data or zero search matches",
      why: "Empty states carry distinct layout and guidance semantics from alerts",
      instead: "EmptyState (components/ui/empty.tsx)",
    },
  ],
  accessibility: [
    "Error and warning tones announce with role='alert'; neutral/info/success tones announce with role='status'",
    "Drops actions below the text automatically below 28rem container width",
  ],
  limits: {
    inlinePersistentOnly: true,
  },
};

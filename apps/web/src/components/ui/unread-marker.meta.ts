import type { ComponentMeta } from "#src/components/ui/component-meta";

export const unreadMarkerMeta: ComponentMeta = {
  component: "UnreadBadge",
  category: "state",
  whenToUse: [
    "Numeric unread counts, neutral fixed-height count capsules (CountBadge), split unread/thread capsules, and bare unread dots",
    "Caps counts above 99 to '99+', hides automatically at 0, and animates changes via RollingNumber",
  ],
  whenNotToUse: [
    {
      when: "Rendering Untitled UI Badge for bare numeric counts or unread markers",
      why: "Badge is a labelled status pill rather than a fixed-height tabular numeric capsule",
      instead: "UnreadBadge / CountBadge (components/ui/unread-marker.tsx)",
    },
    {
      when: "Showing an unread badge on a row with count === 0",
      why: "Zero unread counts must be hidden so unread markers preserve visual signal",
      instead: "Pass count to UnreadBadge, which returns null at 0",
    },
  ],
  motion: {
    reducedMotion: "instant",
  },
  accessibility: ["Uses tabular-nums so count changes never shift sibling text"],
  limits: {
    capAbove: 99,
    hideAtZero: true,
  },
};

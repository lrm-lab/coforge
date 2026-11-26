import type { ComponentMeta } from "#src/components/ui/component-meta";

export const rollingNumberMeta: ComponentMeta = {
  component: "RollingNumber",
  category: "motion",
  whenToUse: [
    "Live non-negative counters that increment or decrement in place (unread badges, message reaction counts)",
    "Stays plain tabular-nums text on first render and only animates after the value actually changes",
  ],
  whenNotToUse: [
    {
      when: "Static metrics, table totals, timestamps, or initial page-load counts",
      why: "Rolling static numbers on mount adds visual noise without communicating a live change",
      instead: "Plain tabular-nums text formatted via formatNumber()",
    },
    {
      when: "Animating emojis flying across the screen toward a reaction badge",
      why: "Project design policy explicitly rejects fly-to-badge reaction animations",
      instead: "In-place RollingNumber count update only",
    },
  ],
  motion: {
    spring: "visualDuration 0.3s, bounce 0.15",
    transform: "per-digit vertical odometer carry",
    reducedMotion: "instant",
  },
  accessibility: [
    "Renders an sr-only plain number alongside aria-hidden animated digit columns",
    "Always applies tabular-nums so surrounding layout never jitters",
  ],
  limits: {
    animateOnInitialMount: false,
    flyToBadgeAllowed: false,
  },
};

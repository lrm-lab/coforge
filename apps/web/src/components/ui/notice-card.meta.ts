import type { ComponentMeta } from "#src/components/ui/component-meta";
import { DURATION_MS } from "#src/utils/motion-tokens";

export const noticeCardMeta: ComponentMeta = {
  component: "NoticeCard",
  category: "feedback",
  whenToUse: [
    "System-initiated notices such as a new app version, finished background job, failed async upgrade, or security/billing alerts",
    "Mounted exclusively through AppToastProvider with a built-in pager when multiple notices exist",
  ],
  whenNotToUse: [
    {
      when: "Incoming chat messages, mentions, or thread replies",
      why: "Conversation events belong to OS notifications and the Activity inbox, not floating notice cards",
      instead: "Activity inbox and Web Push notifications",
    },
    {
      when: "Confirming an action the user just triggered",
      why: "Action confirmations belong to transient single-line toasts",
      instead: "useAppToast() (components/ui/toast.tsx)",
    },
  ],
  motion: {
    enterMs: DURATION_MS.md,
    exitMs: DURATION_MS.mdOut,
    reducedMotion: "fade-only",
  },
  limits: {
    maxVisibleCards: 1,
    systemEventsOnly: true,
  },
};

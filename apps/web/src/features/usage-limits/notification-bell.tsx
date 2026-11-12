import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { Bell01 } from "@untitledui/icons";
import { useState, type ReactNode } from "react";
import {
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Modal as AriaModal,
  ModalOverlay as AriaModalOverlay,
  Popover as AriaPopover,
} from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Fold } from "#src/components/ui/fold";
import { UnreadBadge } from "#src/components/ui/unread-marker";
import { runtimeProviderLabel } from "#src/features/agents/runtime-provider-display";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { formatMonthDayTime } from "#src/lib/dates";
import { useTimeFormat } from "#src/lib/time-format-context";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { POPOVER_MOTION } from "#src/utils/popover-motion";

import { useSystemNotifications } from "./system-notifications-provider";
import { useLeavingItems } from "./use-leaving-items";
import type { UsageLimitNotice } from "./usage-limit-notices";

const appRoute = getRouteApi("/w/$workspaceSlug");

/** One card; the same shape takes the notices to come (a Computer offline, an update needed). */
function UsageLimitCard({
  notice,
  unseen,
  onView,
  onDismiss,
}: {
  notice: UsageLimitNotice;
  unseen: boolean;
  onView: () => void;
  onDismiss: () => void;
}) {
  const timeZone = appRoute.useLoaderData().timeZone;
  const timeFormat = useTimeFormat();
  const details = { count: notice.agents.length, computer: notice.computerName };
  return (
    <div className="flex gap-2 border-b border-secondary p-4 pl-3">
      <span className="flex h-5 w-2 shrink-0 items-center">
        {unseen && <span aria-hidden="true" className="size-2 rounded-full bg-error-solid" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-primary">
          {m.usage_limit_title({
            provider: runtimeProviderLabel(notice.provider as RuntimeProvider),
          })}
        </p>
        <p className="mt-1 text-sm break-words text-tertiary">
          {notice.resetsAt
            ? m.usage_limit_body_reset({
                ...details,
                resetsAt: formatMonthDayTime(notice.resetsAt, timeZone, getLocale(), timeFormat),
              })
            : m.usage_limit_body(details)}
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" color="secondary" onPress={onView}>
            {m.system_notification_view()}
          </Button>
          <Button size="sm" color="tertiary" onPress={onDismiss}>
            {m.system_notification_dismiss()}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The title and the cards, which fade and fold away as they go. */
function NoticeList({
  workspaceSlug,
  shownUnseen,
  close,
}: {
  workspaceSlug: string;
  /** What was unseen when the list opened: their dots stay until it closes and marks them seen. */
  shownUnseen: ReadonlySet<string>;
  close: () => void;
}) {
  const navigate = useNavigate();
  const notifications = useSystemNotifications();
  const rows = useLeavingItems(notifications.notices);
  return (
    <>
      <h2 className="border-b border-secondary px-4 py-3 text-sm font-semibold text-primary">
        {m.system_notifications_title()}
      </h2>
      {rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-tertiary">
          {m.system_notifications_empty()}
        </p>
      ) : (
        <ul className="-mb-px min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
          {rows.map(({ item, leaving }) => (
            <li key={item.id}>
              <Fold open={!leaving}>
                <UsageLimitCard
                  notice={item}
                  unseen={shownUnseen.has(item.id)}
                  onView={() => {
                    close();
                    void navigate({
                      to: "/w/$workspaceSlug/computer/$computerId",
                      params: { workspaceSlug, computerId: item.computerId },
                    });
                  }}
                  onDismiss={() => notifications.dismiss(item.id)}
                />
              </Fold>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** A phone's panel: a sheet up from the bottom, over the page the bell sits in. */
function NoticeSheet({ children }: { children: ReactNode }) {
  return (
    <AriaModalOverlay
      isDismissable
      className={({ isEntering, isExiting }) =>
        cn(
          "fixed inset-0 z-50 flex items-end bg-overlay/70",
          isEntering && "motion-enter animate-in fade-in",
          isExiting && "motion-leave animate-out fade-out",
        )
      }
    >
      <AriaModal
        className={({ isEntering, isExiting }) =>
          cn(
            "w-full",
            isEntering && "motion-enter-lg animate-in slide-in-from-bottom",
            isExiting && "motion-leave-lg animate-out slide-out-to-bottom",
          )
        }
      >
        {children}
      </AriaModal>
    </AriaModalOverlay>
  );
}

/**
 * Every member's bell (task #641), with the unread count in the same badge as the Activity row's.
 * In the sidebar it opens to the right, clear of the sidebar's edge; on a phone, in a tab home's
 * header, it opens as a sheet. What was open counts as seen once the panel closes, so its dots stay
 * for as long as it is read.
 */
export function NotificationBell({
  workspaceSlug,
  badgeRing,
}: {
  workspaceSlug: string;
  /** The badge's ring, in the colour of what the bell sits on, so the count reads apart from the
   * bell's outline. */
  badgeRing: string;
}) {
  const notifications = useSystemNotifications();
  const wide = useBreakpoint("lg");
  const [open, setOpen] = useState(false);
  const [shownUnseen, setShownUnseen] = useState<ReadonlySet<string>>(new Set());
  const { notices, unseen, markSeen } = notifications;
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next)
      setShownUnseen(
        new Set(notices.filter((each) => each.viewer.seenAt === null).map((each) => each.id)),
      );
    else markSeen(notices.filter((each) => each.viewer.seenAt === null).map((each) => each.id));
  };
  const panel = (
    <AriaDialog
      aria-label={m.system_notifications_title()}
      className="flex max-h-[inherit] flex-col overflow-hidden outline-hidden"
    >
      {({ close }) => (
        <NoticeList workspaceSlug={workspaceSlug} shownUnseen={shownUnseen} close={close} />
      )}
    </AriaDialog>
  );
  return (
    <AriaDialogTrigger isOpen={open} onOpenChange={onOpenChange}>
      <span className="relative inline-flex shrink-0">
        <ButtonUtility
          icon={Bell01}
          size="sm"
          color="tertiary"
          tooltip={m.system_notifications_bell()}
          aria-label={
            unseen > 0
              ? m.system_notifications_bell_unread({ count: unseen })
              : m.system_notifications_bell()
          }
        />
        {unseen > 0 && (
          <UnreadBadge
            count={unseen}
            className={cn(
              "pointer-events-none absolute -top-0.5 -right-0.5 h-4 min-w-4 px-1 ring-2 transition-colors duration-100 ease-linear",
              badgeRing,
            )}
          />
        )}
      </span>
      {wide ? (
        <AriaPopover
          // The bell sits 0.75rem in from the sidebar's edge; the panel opens 0.5rem past it.
          placement="right bottom"
          offset={20}
          className={cn(
            "flex max-h-[32.5rem] w-[23.75rem] origin-(--trigger-anchor-point) flex-col overflow-hidden rounded-xl bg-primary shadow-lg ring-1 ring-secondary",
            POPOVER_MOTION,
          )}
        >
          {panel}
        </AriaPopover>
      ) : (
        <NoticeSheet>
          <div className="flex max-h-[80dvh] flex-col overflow-hidden rounded-t-2xl bg-primary pb-safe-bottom">
            <span
              aria-hidden="true"
              className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-quaternary"
            />
            {panel}
          </div>
        </NoticeSheet>
      )}
    </AriaDialogTrigger>
  );
}

import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { AlertCircle, Bell01, XClose } from "@untitledui/icons";
import { useState, type ReactNode } from "react";
import {
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Popover as AriaPopover,
} from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { Fold } from "#src/components/ui/fold";
import { Modal, ModalOverlay, SheetGrabber } from "#src/components/ui/modal";
import { Skeleton } from "#src/components/ui/skeleton";
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

function NoticeList({
  workspaceSlug,
  shownUnseen,
  close,
}: {
  workspaceSlug: string;
  shownUnseen: ReadonlySet<string>;
  close: () => void;
}) {
  const navigate = useNavigate();
  const notifications = useSystemNotifications();
  const rows = useLeavingItems(notifications.notices);
  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b border-secondary px-4 py-3">
        <h2 className="text-sm font-semibold text-primary">{m.system_notifications_title()}</h2>
        <ButtonUtility
          icon={XClose}
          size="xs"
          color="tertiary"
          aria-label={m.controls_close()}
          onClick={close}
          className="lg:hidden"
        />
      </div>
      {notifications.loading ? (
        <div role="status" aria-label={m.empty_notifications_loading()} className="grid gap-3 p-4">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : notifications.failed ? (
        <div className="p-3">
          <EmptyState
            size="card"
            role="alert"
            picture={<EmptyIcon icon={AlertCircle} size="card" />}
            title={m.empty_notifications_load_failed()}
            primaryAction={
              <RetryButton
                size="card"
                isRetrying={notifications.retrying}
                onPress={notifications.retry}
              />
            }
          />
        </div>
      ) : rows.length === 0 ? (
        <div className="p-3">
          <EmptyState
            size="card"
            picture={<EmptyIcon icon={Bell01} size="card" muted />}
            title={m.empty_notifications_all_done()}
          />
        </div>
      ) : (
        <ul className="scroll-fade-y -mb-px min-h-0 flex-1 overflow-y-auto scroll-py-6 [scrollbar-width:thin]">
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

function NoticeSheet({ children }: { children: ReactNode }) {
  return (
    <ModalOverlay
      isDismissable
      className="items-end px-0 sm:items-end sm:px-0 [--modal-pb:0rem] sm:[--modal-pb:0rem]"
    >
      <Modal
        className={(state) =>
          cn(
            "relative flex max-h-[80dvh] w-full max-w-none flex-col overflow-hidden rounded-t-2xl rounded-b-none sm:rounded-t-2xl sm:rounded-b-none pb-safe-bottom",
            "zoom-in-100 zoom-out-100 slide-in-from-bottom slide-out-to-bottom",
            state.isEntering && "motion-enter-lg",
            state.isExiting && "motion-leave-lg",
          )
        }
      >
        <SheetGrabber className="sm:flex" />
        <div className="flex min-h-0 flex-1 flex-col pt-5">{children}</div>
      </Modal>
    </ModalOverlay>
  );
}

export function NotificationBell({
  workspaceSlug,
  badgeRing,
}: {
  workspaceSlug: string;
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
              "pointer-events-none absolute -top-0.5 -right-0.5 h-4 min-w-4 px-1 ring-2 transition-colors duration-100 ease-out",
              badgeRing,
            )}
          />
        )}
      </span>
      {wide ? (
        <AriaPopover
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
        <NoticeSheet>{panel}</NoticeSheet>
      )}
    </AriaDialogTrigger>
  );
}

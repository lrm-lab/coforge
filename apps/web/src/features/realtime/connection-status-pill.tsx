import { Loading02, WifiOff } from "@untitledui/icons";
import { Popover as AriaPopover } from "react-aria-components";

import { Dialog, DialogTrigger } from "#src/components/application/modals/modal";
import { BadgeWithIcon } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { clockLabel } from "#src/lib/dates";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";

import { useRealtimeConnection } from "./browser-realtime";

/**
 * The page's realtime connection beside a list's title, shown only while it is down: a gray pill
 * that says it is reconnecting, then that the page is offline. Offline opens what that means and
 * a Retry. The list under it keeps what it shows; nothing is greyed out.
 */
export function ConnectionStatusPill() {
  const connection = useRealtimeConnection();
  // One live region, present while quiet too, so a change is announced when the pill appears.
  return (
    <div role="status" className="flex shrink-0 items-center">
      {connection?.status === "reconnecting" && (
        <BadgeWithIcon
          size="sm"
          color="gray"
          iconLeading={Loading02}
          className="[&_svg]:motion-safe:animate-spin"
        >
          {m.connection_reconnecting()}
        </BadgeWithIcon>
      )}
      {connection?.status === "offline" && (
        <OfflinePill
          lostAt={connection.lostAt}
          retry={connection.browserOnline ? connection.retry : undefined}
        />
      )}
    </div>
  );
}

/** Without `retry` the browser itself is offline: a connect cannot succeed, so none is offered. */
function OfflinePill({ lostAt, retry }: { lostAt: number | null; retry?: () => void }) {
  const title = retry ? m.connection_offline_title() : m.connection_device_offline_title();
  const timeZone = useTimeZone();
  const timeFormat = useTimeFormat();
  return (
    <DialogTrigger>
      {/* A press target is a button, not a badge (design §11). */}
      <Button color="tertiary" size="xs" iconLeading={WifiOff}>
        {m.connection_offline()}
      </Button>
      <AriaPopover
        placement="bottom end"
        offset={6}
        className="w-72 max-w-[calc(100vw-1rem)] rounded-xl bg-primary shadow-lg ring-1 ring-secondary_alt outline-none"
      >
        <Dialog aria-label={title} className="outline-none">
          {({ close }) => (
            <div className="flex flex-col gap-3 p-4">
              <div className="flex flex-col gap-1">
                <p className="text-sm font-semibold text-primary">{title}</p>
                <p className="text-sm text-tertiary">
                  {lostAt !== null &&
                    `${m.connection_offline_since({
                      time: clockLabel(new Date(lostAt), getLocale(), timeFormat, timeZone),
                    })} `}
                  {m.connection_offline_body()}
                </p>
              </div>
              {retry && (
                <Button
                  color="secondary"
                  size="sm"
                  className="self-end"
                  onPress={() => {
                    retry();
                    close();
                  }}
                >
                  {m.connection_retry_now()}
                </Button>
              )}
            </div>
          )}
        </Dialog>
      </AriaPopover>
    </DialogTrigger>
  );
}

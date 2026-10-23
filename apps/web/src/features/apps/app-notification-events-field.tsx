import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { m } from "#src/paraglide/messages";
import { APP_NOTIFICATION_EVENT_LABELS } from "./app-notification-copy";
import {
  eventAllowedBy,
  eventsAllowedBy,
  offeredNotificationEvents,
  requiredGroupsOf,
  type AppNotificationEventName,
} from "./app-notification-events";
import { APP_PERMISSION_GROUP_COPY, permissionGroupList } from "./app-permission-copy";
import type { AppPermissionGroup } from "./app-permissions";

/**
 * The "Webhook events" checklist, grouped by data group. An event can be chosen only while the
 * form's App permissions select every group it needs; the others stay listed, disabled, with the
 * groups to select. The choice is saved with the form's Save.
 */
export function NotificationEventsField({
  groups,
  events,
  isDisabled,
  onChange,
}: {
  /** The data groups chosen in the form, saved or not. */
  groups: readonly AppPermissionGroup[];
  /** The events chosen in the form, saved or not. */
  events: readonly AppNotificationEventName[];
  isDisabled: boolean;
  onChange: (events: AppNotificationEventName[]) => void;
}) {
  const chosen = eventsAllowedBy(events, groups);
  const offered = offeredNotificationEvents(groups);
  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h4 className="text-sm font-semibold text-primary">
          {m.apps_notifications_events_title()}
        </h4>
        <p className="text-sm text-tertiary">{m.apps_notifications_events_description()}</p>
        <p className="text-sm text-tertiary">
          {m.apps_notifications_events_selected({ count: chosen.length })}
        </p>
      </div>
      {offered.length === 0 && (
        <p className="text-sm text-tertiary">{m.apps_notifications_events_no_groups()}</p>
      )}
      {offered.map(({ group, events: groupEvents }) => (
        <fieldset key={group} className="grid gap-3">
          <legend className="mb-2 text-sm font-medium text-secondary">
            {m.apps_notifications_events_group({ group: APP_PERMISSION_GROUP_COPY[group].label() })}
          </legend>
          {groupEvents.map((event) => {
            const allowed = eventAllowedBy(event, groups);
            return (
              <Checkbox
                key={event}
                label={APP_NOTIFICATION_EVENT_LABELS[event]()}
                hint={
                  allowed
                    ? event
                    : m.apps_notifications_events_needs_group({
                        groups: permissionGroupList(
                          requiredGroupsOf(event).filter((needed) => !groups.includes(needed)),
                        ),
                      })
                }
                isDisabled={isDisabled || !allowed}
                isSelected={chosen.includes(event)}
                onChange={(on) =>
                  onChange(
                    eventsAllowedBy(
                      on ? [...chosen, event] : chosen.filter((c) => c !== event),
                      groups,
                    ),
                  )
                }
              />
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}

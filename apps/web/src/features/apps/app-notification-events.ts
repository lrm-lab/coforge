import {
  APP_PERMISSION_GROUPS,
  effectivePermissionGroups,
  type AppPermissionGroup,
} from "./app-permissions";

/**
 * The events an app can subscribe to, each with the data groups it needs. Pure and client-safe;
 * `server/app-notifications/` fans events out by it. Raft's event catalog (its `Bl` map) with the
 * Workspace as `workspace.*` where Raft says `server.*`. The catalog is the types an app may
 * subscribe to; an event is delivered once something records it (`AppNotifications.record`), and
 * the editor offers only `APP_NOTIFICATION_EMITTED_EVENTS`. `server.plan_changed` and
 * `thread.resolved` have no CoForge counterpart.
 */
export const APP_NOTIFICATION_EVENT_GROUPS = {
  "workspace.member_added": ["workspace"],
  "workspace.member_removed": ["workspace"],
  "workspace.member_role_changed": ["workspace"],
  "workspace.config_updated": ["workspace"],
  "workspace.public_channel_created": ["workspace", "channel"],
  "workspace.public_channel_archived": ["workspace", "channel"],
  "channel.member_added": ["channel"],
  "channel.member_removed": ["channel"],
  "channel.config_updated": ["channel"],
  "channel.archived": ["channel"],
  "thread.created": ["channel"],
  "agent.status_changed": ["agent"],
  "agent.profile_updated": ["agent"],
  "agent.runtime_changed": ["agent"],
  "agent.model_changed": ["agent"],
  "computer.online": ["computer"],
  "computer.offline": ["computer"],
  "computer.version_changed": ["computer"],
  "computer.agent_started": ["computer", "agent"],
  "computer.agent_stopped": ["computer", "agent"],
} as const satisfies Record<string, readonly AppPermissionGroup[]>;

export type AppNotificationEventName = keyof typeof APP_NOTIFICATION_EVENT_GROUPS;

/** The events something records today, which the editor offers; the server asserts at compile
 * time that this is exactly the recorded set (`AppNotificationEventPayload`). */
export const APP_NOTIFICATION_EMITTED_EVENTS = [
  "workspace.member_added",
  "workspace.member_removed",
  "workspace.member_role_changed",
  "workspace.config_updated",
  "workspace.public_channel_created",
  "workspace.public_channel_archived",
  "channel.archived",
  "channel.member_added",
  "channel.member_removed",
  "channel.config_updated",
  "thread.created",
  "agent.profile_updated",
  "agent.runtime_changed",
  "agent.model_changed",
  "computer.version_changed",
  "computer.agent_started",
  "computer.agent_stopped",
  "agent.status_changed",
  "computer.online",
  "computer.offline",
] as const satisfies readonly AppNotificationEventName[];

/** Every event, in the order lists of them are kept and shown. */
export const APP_NOTIFICATION_EVENT_NAMES = Object.keys(
  APP_NOTIFICATION_EVENT_GROUPS,
) as AppNotificationEventName[];

/** The `errorId` a subscription naming anything outside the catalog, or an event whose data the
 * app does not declare, is refused with. */
export const APP_NOTIFICATION_EVENTS_INVALID = "app-notification-events-invalid";

/** The data groups an event needs: the app must declare all of them to subscribe, and the
 * installation must approve all of them to receive it. */
export const requiredGroupsOf = (event: AppNotificationEventName): readonly AppPermissionGroup[] =>
  APP_NOTIFICATION_EVENT_GROUPS[event];

/** The group the editor lists an event under: the first it needs. */
export const eventGroupOf = (event: AppNotificationEventName): AppPermissionGroup =>
  APP_NOTIFICATION_EVENT_GROUPS[event][0];

/** Whether `groups` hold everything the event needs. */
export const eventAllowedBy = (
  event: AppNotificationEventName,
  groups: readonly AppPermissionGroup[],
) => requiredGroupsOf(event).every((group) => groups.includes(group));

/** The events `value` names, once each and in catalog order, or `undefined` when it is not a list
 * of catalog names. */
export function checkNotificationEvents(value: unknown): AppNotificationEventName[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const known: readonly unknown[] = APP_NOTIFICATION_EVENT_NAMES;
  if (!value.every((event) => known.includes(event))) return undefined;
  return APP_NOTIFICATION_EVENT_NAMES.filter((event) => value.includes(event));
}

/** Whether both lists name the same events, whatever their order. */
export const sameNotificationEvents = (
  a: readonly AppNotificationEventName[],
  b: readonly AppNotificationEventName[],
) => a.length === b.length && a.every((event) => b.includes(event));

/** `events` kept in catalog order, without those `groups` do not cover. */
export const eventsAllowedBy = (
  events: readonly AppNotificationEventName[],
  groups: readonly AppPermissionGroup[],
) => APP_NOTIFICATION_EVENT_NAMES.filter((e) => events.includes(e) && eventAllowedBy(e, groups));

/**
 * What an installation is delivered: the events the app subscribes to and the installation
 * approved, whose data groups it also approved and the app still declares. Dropping a group stops
 * its events at once; a group or event the app adds waits for approval.
 */
export const effectiveNotificationEvents = (input: {
  subscribed: readonly AppNotificationEventName[];
  approvedEvents: readonly AppNotificationEventName[];
  declaredGroups: readonly AppPermissionGroup[];
  approvedGroups: readonly AppPermissionGroup[];
}) =>
  eventsAllowedBy(
    input.subscribed.filter((event) => input.approvedEvents.includes(event)),
    effectivePermissionGroups(input.declaredGroups, input.approvedGroups),
  );

/** What waits for approval: the subscribed events not approved. */
export const pendingNotificationEvents = (
  subscribed: readonly AppNotificationEventName[],
  approvedEvents: readonly AppNotificationEventName[],
) =>
  APP_NOTIFICATION_EVENT_NAMES.filter((e) => subscribed.includes(e) && !approvedEvents.includes(e));

/** The events the editor offers, grouped under the group each is listed by, in
 * `APP_PERMISSION_GROUPS` order; only the groups in `groups` (the ones the app declares) and only
 * the events recorded today. */
export const offeredNotificationEvents = (groups: readonly AppPermissionGroup[]) =>
  APP_PERMISSION_GROUPS.filter((group) => groups.includes(group))
    .map((group) => ({
      group,
      events: APP_NOTIFICATION_EMITTED_EVENTS.filter((event) => eventGroupOf(event) === group),
    }))
    .filter(({ events }) => events.length > 0);

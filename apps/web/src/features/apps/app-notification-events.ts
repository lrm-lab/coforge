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

const NOTIFICATION_EVENT_NAME_SET = new Set<unknown>(APP_NOTIFICATION_EVENT_NAMES);

export const eventAllowedBy = (
  event: AppNotificationEventName,
  groups: readonly AppPermissionGroup[],
) => {
  const groupSet = new Set(groups);
  return requiredGroupsOf(event).every((group) => groupSet.has(group));
};

export function checkNotificationEvents(value: unknown): AppNotificationEventName[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((event) => NOTIFICATION_EVENT_NAME_SET.has(event))) return undefined;
  const valueSet = new Set<unknown>(value);
  return APP_NOTIFICATION_EVENT_NAMES.filter((event) => valueSet.has(event));
}

export const sameNotificationEvents = (
  a: readonly AppNotificationEventName[],
  b: readonly AppNotificationEventName[],
) => {
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  return a.every((event) => bSet.has(event));
};

export const eventsAllowedBy = (
  events: readonly AppNotificationEventName[],
  groups: readonly AppPermissionGroup[],
) => {
  const eventSet = new Set(events);
  return APP_NOTIFICATION_EVENT_NAMES.filter((e) => eventSet.has(e) && eventAllowedBy(e, groups));
};

export const effectiveNotificationEvents = (input: {
  subscribed: readonly AppNotificationEventName[];
  approvedEvents: readonly AppNotificationEventName[];
  declaredGroups: readonly AppPermissionGroup[];
  approvedGroups: readonly AppPermissionGroup[];
}) => {
  const approvedSet = new Set(input.approvedEvents);
  return eventsAllowedBy(
    input.subscribed.filter((event) => approvedSet.has(event)),
    effectivePermissionGroups(input.declaredGroups, input.approvedGroups),
  );
};

export const pendingNotificationEvents = (
  subscribed: readonly AppNotificationEventName[],
  approvedEvents: readonly AppNotificationEventName[],
) => {
  const subscribedSet = new Set(subscribed);
  const approvedSet = new Set(approvedEvents);
  return APP_NOTIFICATION_EVENT_NAMES.filter((e) => subscribedSet.has(e) && !approvedSet.has(e));
};

export const offeredNotificationEvents = (groups: readonly AppPermissionGroup[]) => {
  const groupSet = new Set(groups);
  return APP_PERMISSION_GROUPS.filter((group) => groupSet.has(group))
    .map((group) => ({
      group,
      events: APP_NOTIFICATION_EMITTED_EVENTS.filter((event) => eventGroupOf(event) === group),
    }))
    .filter(({ events }) => events.length > 0);
};

import { AppError } from "#src/lib/app-error";
import { APP_NOTIFICATIONS_OFF } from "#src/features/apps/app-webhook";
import {
  APP_PERMISSION_GROUPS_INVALID,
  APP_PERMISSIONS_CHANGED,
  checkPermissionGroups,
  effectivePermissionGroups,
  pendingPermissionGroups,
  samePermissionGroups,
  type AppPermissionGroup,
} from "#src/features/apps/app-permissions";
import {
  APP_NOTIFICATION_EVENTS_INVALID,
  checkNotificationEvents,
  effectiveNotificationEvents,
  eventsAllowedBy,
  pendingNotificationEvents,
  sameNotificationEvents,
  type AppNotificationEventName,
} from "#src/features/apps/app-notification-events";
import type { AppActor } from "#src/server/apps/app-registry.server";
import {
  assertCanManageApps,
  type WorkspaceMemberRole,
} from "#src/server/workspaces/member-role.server";

/** An app installed in a Workspace, with what it declares and what that installation approved. */
export type InstalledAppPermissions = {
  /** This Workspace's installation of the app. */
  installationId: string;
  key: string;
  ownerWorkspaceId: string;
  declared: AppPermissionGroup[];
  revision: number;
  approved: AppPermissionGroup[];
  approvedRevision: number;
  approvedAt: Date | null;
  /** The notification events the app subscribes to, and the ones this installation approved. */
  events: AppNotificationEventName[];
  approvedEvents: AppNotificationEventName[];
};

/** An app's permissions where it is installed, with what follows from them. */
export type AppPermissionsView = Omit<InstalledAppPermissions, "key" | "ownerWorkspaceId"> & {
  /** The approved groups the app still declares: what it may read. */
  effective: AppPermissionGroup[];
  /** The declared groups waiting for an owner's or admin's approval. */
  pending: AppPermissionGroup[];
  /** The events delivered: subscribed, approved, and covered by the effective groups. */
  effectiveEvents: AppNotificationEventName[];
  /** The subscribed events waiting for approval, with `pending`. */
  pendingEvents: AppNotificationEventName[];
};

export interface AppPermissionsStore {
  /** The person's role in the Workspace, and the Workspace's slug, which a flag rule may match. */
  findMember(
    workspaceId: string,
    userId: string,
  ): Promise<{ role: WorkspaceMemberRole; workspaceSlug: string } | undefined>;
  /** The apps installed in the Workspace. */
  listInstalled(workspaceId: string): Promise<InstalledAppPermissions[]>;
  findInstalled(workspaceId: string, key: string): Promise<InstalledAppPermissions | undefined>;
  /** Declares `groups` and `events` for the app `key` that `ownerWorkspaceId` owns and moves it
   * to the next revision, only while it is still at `revision`; every installation's approval
   * drops the groups and events no longer declared. `false` when the app is not at `revision`, or
   * not there. */
  declare(input: {
    ownerWorkspaceId: string;
    key: string;
    groups: AppPermissionGroup[];
    events: AppNotificationEventName[];
    revision: number;
  }): Promise<boolean>;
  /** Records the app's installation in `workspaceId` as approving `groups` at `revision`, by
   * `userId` at `at` (with the subscribed `events`), only while the app is still at `revision`. `false` when it is not, or there is
   * no such installation. */
  approve(input: {
    workspaceId: string;
    key: string;
    groups: AppPermissionGroup[];
    events: AppNotificationEventName[];
    revision: number;
    userId: string;
    at: Date;
  }): Promise<boolean>;
}

/** Whether the `app-data-permissions` flag is on for the Workspace. */
export type DataPermissionsFlag = (workspace: {
  workspaceId: string;
  workspaceSlug: string;
}) => Promise<boolean>;

/** The refusal for a Workspace where `app-data-permissions` is off: the feature is not there. */
const OFF = () => new AppError("ACCESS_DENIED", { errorId: "app-data-permissions-off" });
/** The app's declaration moved on since it was read or shown. */
const CHANGED = () => new AppError("CONFLICT", { errorId: APP_PERMISSIONS_CHANGED });

/** Events are shown only where `app-notifications` is on: without it the app subscribes to none. */
function viewOf(
  { key: _key, ownerWorkspaceId: _owner, ...app }: InstalledAppPermissions,
  notifications: boolean,
) {
  const shown = notifications ? app : { ...app, events: [], approvedEvents: [] };
  return {
    ...shown,
    effective: effectivePermissionGroups(shown.declared, shown.approved),
    pending: pendingPermissionGroups(shown.declared, shown.approved),
    effectiveEvents: effectiveNotificationEvents({
      subscribed: shown.events,
      approvedEvents: shown.approvedEvents,
      declaredGroups: shown.declared,
      approvedGroups: shown.approved,
    }),
    pendingEvents: pendingNotificationEvents(shown.events, shown.approvedEvents),
  } satisfies AppPermissionsView;
}

/**
 * The data an app may read where it is installed (`features/apps/app-permissions.ts`), behind the
 * `app-data-permissions` flag. Every member of a Workspace sees its apps' permissions; its owners
 * and admins declare its own apps' groups and approve its installations' updates. A declared group
 * is read only once approved; a group the app stops declaring stops at once and leaves every
 * approval, so declaring it again needs a new one. An approval names the revision it was shown, and
 * a declaration made since refuses it. With the flag off nothing is shown and nothing changes.
 */
export class AppPermissions {
  constructor(
    private readonly store: AppPermissionsStore,
    private readonly flagOn: DataPermissionsFlag,
    /** Settles that `key` is the actor's Workspace's own app and the actor may manage apps
     * (`AppRegistry.requireOwnApp`); throws otherwise. */
    private readonly requireOwnApp: (actor: AppActor, key: string) => Promise<unknown>,
    private readonly now: () => Date = () => new Date(),
    /** Whether `app-notifications` is on; notification events are declared and shown only there. */
    private readonly notificationsOn: DataPermissionsFlag = async () => false,
  ) {}

  /** The permissions of every app installed in the actor's Workspace, by key, and whether
   * `app-notifications` is on there (their events are shown only then); `null` while the
   * data-permissions flag is off there. */
  async workspacePermissions(
    actor: AppActor,
  ): Promise<{ apps: Map<string, AppPermissionsView>; notifications: boolean } | null> {
    const member = await this.enabledMember(actor);
    if (!member) return null;
    const notifications = await this.eventsShown(actor, member);
    const apps = await this.store.listInstalled(actor.workspaceId);
    return {
      apps: new Map(apps.map((app) => [app.key, viewOf(app, notifications)])),
      notifications,
    };
  }

  /** The permissions of app `key` installed in the actor's Workspace; `null` while the flag is off
   * there. */
  async appPermissions(actor: AppActor, key: string): Promise<AppPermissionsView | null> {
    const member = await this.enabledMember(actor);
    return member ? this.current(actor, key, member) : null;
  }

  /** Declares the groups the Workspace's own app `key` reads and, when `events` is given, the
   * notification events it subscribes to (refused where `app-notifications` is off, and for an
   * event needing a group the app does not declare); the revision moves on only when either set
   * changes. Without `events`, the subscription keeps the events the groups still cover. Run in a
   * transaction with the app's other changes (`AppEditorSave`) when they must stand or fall
   * together. */
  async declare(
    actor: AppActor,
    key: string,
    groups: unknown,
    events?: unknown,
  ): Promise<AppPermissionsView> {
    const member = await this.requireManager(actor);
    const declared = checkPermissionGroups(groups);
    if (!declared) throw new AppError("INVALID_INPUT", { errorId: APP_PERMISSION_GROUPS_INVALID });
    const subscribed = events === undefined ? undefined : checkNotificationEvents(events);
    const notifications = await this.eventsShown(actor, member);
    if (events !== undefined && !notifications) {
      throw new AppError("ACCESS_DENIED", { errorId: APP_NOTIFICATIONS_OFF });
    }
    if (events !== undefined && !subscribed) {
      throw new AppError("INVALID_INPUT", { errorId: APP_NOTIFICATION_EVENTS_INVALID });
    }
    if (subscribed && eventsAllowedBy(subscribed, declared).length !== subscribed.length) {
      throw new AppError("INVALID_INPUT", { errorId: APP_NOTIFICATION_EVENTS_INVALID });
    }
    await this.requireOwnApp(actor, key);
    const app = await this.store.findInstalled(actor.workspaceId, key);
    if (!app) throw new AppError("NOT_FOUND");
    const nextEvents = subscribed ?? eventsAllowedBy(app.events, declared);
    if (
      samePermissionGroups(declared, app.declared) &&
      sameNotificationEvents(nextEvents, app.events)
    ) {
      return viewOf(app, notifications);
    }
    const written = await this.store.declare({
      ownerWorkspaceId: actor.workspaceId,
      key,
      groups: declared,
      events: nextEvents,
      revision: app.revision,
    });
    if (!written) throw await this.missedWrite(actor, key);
    return this.current(actor, key, member);
  }

  /** Approves the groups app `key` declares at `revision`, the one the approver was shown, for its
   * installation in the actor's Workspace. */
  async approve(actor: AppActor, key: string, revision: number): Promise<AppPermissionsView> {
    const member = await this.requireManager(actor);
    const app = await this.store.findInstalled(actor.workspaceId, key);
    if (!app) throw new AppError("NOT_FOUND");
    if (app.revision !== revision) throw CHANGED();
    const written = await this.store.approve({
      workspaceId: actor.workspaceId,
      key,
      groups: app.declared,
      events: app.events,
      revision,
      userId: actor.actorUserId,
      at: this.now(),
    });
    if (!written) throw await this.missedWrite(actor, key);
    return this.current(actor, key, member);
  }

  /** The actor's role, when they are a member of a Workspace where the flag is on; `null` while it
   * is off there. */
  private async enabledMember(actor: AppActor): Promise<Member | null> {
    const member = await this.store.findMember(actor.workspaceId, actor.actorUserId);
    if (!member) throw new AppError("ACCESS_DENIED");
    const on = await this.flagOn({
      workspaceId: actor.workspaceId,
      workspaceSlug: member.workspaceSlug,
    });
    return on ? member : null;
  }

  /** The actor may manage apps in a Workspace where the flag is on. */
  private async requireManager(actor: AppActor): Promise<Member> {
    const member = await this.enabledMember(actor);
    if (!member) throw OFF();
    assertCanManageApps(member.role);
    return member;
  }

  private eventsShown(actor: AppActor, member: Member): Promise<boolean> {
    return this.notificationsOn({
      workspaceId: actor.workspaceId,
      workspaceSlug: member.workspaceSlug,
    });
  }

  private async current(actor: AppActor, key: string, member: Member): Promise<AppPermissionsView> {
    const app = await this.store.findInstalled(actor.workspaceId, key);
    if (!app) throw new AppError("NOT_FOUND");
    return viewOf(app, await this.eventsShown(actor, member));
  }

  /** A conditional write that matched nothing: the app moved on, or went. */
  private async missedWrite(actor: AppActor, key: string): Promise<AppError> {
    return (await this.store.findInstalled(actor.workspaceId, key))
      ? CHANGED()
      : new AppError("NOT_FOUND");
  }
}

type Member = { role: WorkspaceMemberRole; workspaceSlug: string };

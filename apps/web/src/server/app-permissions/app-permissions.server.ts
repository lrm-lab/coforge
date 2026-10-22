import { AppError } from "#src/lib/app-error";
import {
  APP_PERMISSION_GROUPS_INVALID,
  APP_PERMISSIONS_CHANGED,
  checkPermissionGroups,
  effectivePermissionGroups,
  pendingPermissionGroups,
  samePermissionGroups,
  type AppPermissionGroup,
} from "#src/features/apps/app-permissions";
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
};

/** An app's permissions where it is installed, with what follows from them. */
export type AppPermissionsView = Omit<InstalledAppPermissions, "key" | "ownerWorkspaceId"> & {
  /** The approved groups the app still declares: what it may read. */
  effective: AppPermissionGroup[];
  /** The declared groups waiting for an owner's or admin's approval. */
  pending: AppPermissionGroup[];
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
  /** Declares `groups` for the app `key` that `ownerWorkspaceId` owns and moves it to the next
   * revision, only while it is still at `revision`; every installation's approval drops the
   * groups no longer declared. `false` when the app is not at `revision`, or not there. */
  declare(input: {
    ownerWorkspaceId: string;
    key: string;
    groups: AppPermissionGroup[];
    revision: number;
  }): Promise<boolean>;
  /** Records the app's installation in `workspaceId` as approving `groups` at `revision`, by
   * `userId` at `at`, only while the app is still at `revision`. `false` when it is not, or there is
   * no such installation. */
  approve(input: {
    workspaceId: string;
    key: string;
    groups: AppPermissionGroup[];
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

function viewOf({ key: _key, ownerWorkspaceId: _owner, ...app }: InstalledAppPermissions) {
  return {
    ...app,
    effective: effectivePermissionGroups(app.declared, app.approved),
    pending: pendingPermissionGroups(app.declared, app.approved),
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
  ) {}

  /** The permissions of every app installed in the actor's Workspace, by key; `null` while the
   * flag is off there. */
  async workspacePermissions(actor: AppActor): Promise<Map<string, AppPermissionsView> | null> {
    if (!(await this.enabledMember(actor))) return null;
    const apps = await this.store.listInstalled(actor.workspaceId);
    return new Map(apps.map((app) => [app.key, viewOf(app)]));
  }

  /** The permissions of app `key` installed in the actor's Workspace; `null` while the flag is off
   * there. */
  async appPermissions(actor: AppActor, key: string): Promise<AppPermissionsView | null> {
    if (!(await this.enabledMember(actor))) return null;
    return this.current(actor, key);
  }

  /** Declares the groups the Workspace's own app `key` reads; the revision moves on only when the
   * set changes. Run in a transaction with the app's other changes (`AppEditorSave`) when they
   * must stand or fall together. */
  async declare(actor: AppActor, key: string, groups: unknown): Promise<AppPermissionsView> {
    await this.requireManager(actor);
    const declared = checkPermissionGroups(groups);
    if (!declared) throw new AppError("INVALID_INPUT", { errorId: APP_PERMISSION_GROUPS_INVALID });
    await this.requireOwnApp(actor, key);
    const app = await this.store.findInstalled(actor.workspaceId, key);
    if (!app) throw new AppError("NOT_FOUND");
    if (samePermissionGroups(declared, app.declared)) return viewOf(app);
    const written = await this.store.declare({
      ownerWorkspaceId: actor.workspaceId,
      key,
      groups: declared,
      revision: app.revision,
    });
    if (!written) throw await this.missedWrite(actor, key);
    return this.current(actor, key);
  }

  /** Approves the groups app `key` declares at `revision`, the one the approver was shown, for its
   * installation in the actor's Workspace. */
  async approve(actor: AppActor, key: string, revision: number): Promise<AppPermissionsView> {
    await this.requireManager(actor);
    const app = await this.store.findInstalled(actor.workspaceId, key);
    if (!app) throw new AppError("NOT_FOUND");
    if (app.revision !== revision) throw CHANGED();
    const written = await this.store.approve({
      workspaceId: actor.workspaceId,
      key,
      groups: app.declared,
      revision,
      userId: actor.actorUserId,
      at: this.now(),
    });
    if (!written) throw await this.missedWrite(actor, key);
    return this.current(actor, key);
  }

  /** The actor's role, when they are a member of a Workspace where the flag is on; `null` while it
   * is off there. */
  private async enabledMember(actor: AppActor): Promise<{ role: WorkspaceMemberRole } | null> {
    const member = await this.store.findMember(actor.workspaceId, actor.actorUserId);
    if (!member) throw new AppError("ACCESS_DENIED");
    const on = await this.flagOn({
      workspaceId: actor.workspaceId,
      workspaceSlug: member.workspaceSlug,
    });
    return on ? member : null;
  }

  /** The actor may manage apps in a Workspace where the flag is on. */
  private async requireManager(actor: AppActor): Promise<void> {
    const member = await this.enabledMember(actor);
    if (!member) throw OFF();
    assertCanManageApps(member.role);
  }

  private async current(actor: AppActor, key: string): Promise<AppPermissionsView> {
    const app = await this.store.findInstalled(actor.workspaceId, key);
    if (!app) throw new AppError("NOT_FOUND");
    return viewOf(app);
  }

  /** A conditional write that matched nothing: the app moved on, or went. */
  private async missedWrite(actor: AppActor, key: string): Promise<AppError> {
    return (await this.store.findInstalled(actor.workspaceId, key))
      ? CHANGED()
      : new AppError("NOT_FOUND");
  }
}

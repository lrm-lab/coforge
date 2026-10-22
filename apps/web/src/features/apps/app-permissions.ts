/**
 * The data an app may read where it is installed: what it declares, what an installation approved,
 * and what follows from the two. Pure and client-safe; `server/app-permissions/` enforces it.
 * Separate from the scopes an app asks for when it signs a person in.
 */

/** The data groups, each read-only, in the order every list of them is kept and shown. */
export const APP_PERMISSION_GROUPS = ["workspace", "agent", "channel", "computer"] as const;
export type AppPermissionGroup = (typeof APP_PERMISSION_GROUPS)[number];

/** The `errorId` a declaration naming anything but the four groups is refused with. */
export const APP_PERMISSION_GROUPS_INVALID = "app-permission-groups-invalid";

/** The `errorId` of the CONFLICT for a declaration that moved on since it was read or shown. */
export const APP_PERMISSIONS_CHANGED = "app-permissions-changed";

/** The groups `value` names, once each and in `APP_PERMISSION_GROUPS` order, or `undefined` when it
 * is not a list of the four groups' names. */
export function checkPermissionGroups(value: unknown): AppPermissionGroup[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const groups: readonly unknown[] = APP_PERMISSION_GROUPS;
  if (!value.every((group) => groups.includes(group))) return undefined;
  return APP_PERMISSION_GROUPS.filter((group) => value.includes(group));
}

/** Whether both lists name the same groups, whatever their order. */
export const samePermissionGroups = (
  a: readonly AppPermissionGroup[],
  b: readonly AppPermissionGroup[],
) => a.length === b.length && a.every((group) => b.includes(group));

/** What the app reads now: the approved groups it still declares, in `APP_PERMISSION_GROUPS` order.
 * A group it stops declaring stops at once, with no approval. */
export const effectivePermissionGroups = (
  declared: readonly AppPermissionGroup[],
  approved: readonly AppPermissionGroup[],
) => APP_PERMISSION_GROUPS.filter((group) => declared.includes(group) && approved.includes(group));

/** What waits for an owner's or admin's approval: the declared groups not approved. */
export const pendingPermissionGroups = (
  declared: readonly AppPermissionGroup[],
  approved: readonly AppPermissionGroup[],
) => APP_PERMISSION_GROUPS.filter((group) => declared.includes(group) && !approved.includes(group));

/** An app's permissions in one Workspace where it is installed, as Settings shows them. */
export type AppPermissionsSummary = {
  /** This Workspace's installation of the app. */
  installationId: string;
  declared: AppPermissionGroup[];
  /** Goes up by one whenever `declared` changes; an approval sends the one it was shown. */
  revision: number;
  effective: AppPermissionGroup[];
  pending: AppPermissionGroup[];
};

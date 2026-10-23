import type { PrismaClient } from "#src/generated/prisma/client";

/** A flagd definition that turns a flag on for the Workspaces with these slugs only. */
export const flagOnFor = (slugs: string[]) => ({
  state: "ENABLED",
  variants: { on: true, off: false },
  defaultVariant: "off",
  targeting: { if: [{ in: [{ var: "workspaceSlug" }, slugs] }, "on", "off"] },
});

/**
 * Makes `workspace.member_added` an effective event for every installation of the app: the app
 * declares the `workspace` group and the event, and its installations approved both. Fan-out
 * delivers an event only to installations with it among their effective events, so tests that
 * expect a delivery start here (and turn `app-data-permissions` on for the Workspace too).
 */
export async function subscribeToMemberAdded(db: PrismaClient, appId: string) {
  await db.app.update({
    where: { id: appId },
    data: { permissionGroups: ["workspace"], notificationEvents: ["workspace.member_added"] },
  });
  await db.appInstallation.updateMany({
    where: { appId },
    data: { approvedGroups: ["workspace"], approvedEvents: ["workspace.member_added"] },
  });
}

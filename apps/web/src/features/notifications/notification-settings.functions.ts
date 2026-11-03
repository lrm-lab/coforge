import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { authMiddleware, workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { extractLocaleFromRequest } from "#src/paraglide/runtime";
import { createWebPushNotifications } from "#src/server/notifications/web-push-composition.server";
import { PrismaWebPushSubscriptionStore } from "#src/server/notifications/prisma-web-push-subscriptions.server";
import { NotificationSettingsStore } from "#src/server/notifications/notification-settings.server";
import { computerActivity } from "#src/server/notifications/notification-redis.server";
import {
  activityReportSchema,
  notificationSettingsChangeSchema,
} from "./notification-settings.schemas";

/**
 * The Settings page's account notification settings (task #467): read them with this person's
 * devices, save a change from a known version, report that this computer is in use, and send a
 * test to every device. The rules are in `server/notifications/`.
 */

const endpointInput = z.object({ endpoint: z.string().max(4_096).optional() });

/** The settings, the zone quiet hours read, and the person's browsers with each one's last
 * outcome; `endpoint` (this browser's own, when it has one) marks the current device. */
// POST: the input is this browser's push endpoint, which must not land in a URL or an access log.
export const getNotificationSettings = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(endpointInput)
  .handler(async ({ data, context }) => {
    const db = requireDatabaseClient();
    const [{ settings, timeZone }, devices] = await Promise.all([
      new NotificationSettingsStore(db).read(context.user.id),
      new PrismaWebPushSubscriptionStore(db).devicesForUser(context.user.id),
    ]);
    return {
      settings: { ...settings, pausedUntil: settings.pausedUntil?.toISOString() ?? null },
      timeZone,
      devices: devices.map(({ endpoint, ...device }) => ({
        ...device,
        lastSuccessAt: device.lastSuccessAt?.toISOString() ?? null,
        lastFailureAt: device.lastFailureAt?.toISOString() ?? null,
        current: data.endpoint !== undefined && endpoint === data.endpoint,
      })),
    };
  });

/** A save from `expectedVersion`; CONFLICT (`notification-settings-version-conflict`, with
 * `currentVersion`) when another device saved first: read the settings again. */
export const updateNotificationSettings = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(notificationSettingsChangeSchema)
  .handler(async ({ data, context }) => {
    const saved = await new NotificationSettingsStore(requireDatabaseClient()).update(
      context.user.id,
      data,
      new Date(),
    );
    return { ...saved, pausedUntil: saved.pausedUntil?.toISOString() ?? null };
  });

/** A computer's CoForge page reports every minute while it is visible and focused (one tab: the
 * focused one), carrying the time of its last keyboard or pointer input, input or not, so a long
 * idle wait (`idle_10m`) can see how long the person has been idle. Only CoForge input counts. */
export const reportComputerActivity = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(activityReportSchema)
  .handler(async ({ data, context }) => {
    await computerActivity()?.report(context.user.id, new Date(data.lastInputAt), new Date());
  });

/** One test notification to each of the person's devices, with each one's outcome. */
export const sendTestNotificationToDevices = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const db = requireDatabaseClient();
    const { slug } = await db.workspace.findUniqueOrThrow({
      where: { id: context.workspaceId },
      select: { slug: true },
    });
    const notifications = await createWebPushNotifications(db);
    return {
      devices: await notifications.sendTestToDevices(
        context.user.id,
        extractLocaleFromRequest(getRequest()),
        slug,
      ),
    };
  });

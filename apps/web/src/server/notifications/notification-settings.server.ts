import { AppError } from "#src/lib/app-error";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import {
  MAX_PAUSE_MS,
  type MobileDelay,
  type NotificationPreviewMode,
  type NotificationSettingsChange,
} from "#src/features/notifications/notification-settings.schemas";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
} from "./notification-rules.server";

/** A save made from a version that is no longer the current one. */
export const NOTIFICATION_SETTINGS_VERSION_CONFLICT = "notification-settings-version-conflict";
/** A pause that would end more than a year ahead. */
export const NOTIFICATION_PAUSE_TOO_LONG = "notification-pause-too-long";

type Client = PrismaClient | Prisma.TransactionClient;
type Row = Prisma.UserNotificationSettingsGetPayload<{ select: typeof ROW }>;

const ROW = {
  pausedUntil: true,
  quietHoursEnabled: true,
  quietStartMinute: true,
  quietEndMinute: true,
  previewMode: true,
  sound: true,
  mobileDelay: true,
  version: true,
} satisfies Prisma.UserNotificationSettingsSelect;

function settingsOf(row: Row | null | undefined): NotificationSettings {
  if (!row) return DEFAULT_NOTIFICATION_SETTINGS;
  return {
    pausedUntil: row.pausedUntil,
    quietHours: {
      enabled: row.quietHoursEnabled,
      startMinute: row.quietStartMinute,
      endMinute: row.quietEndMinute,
    },
    previewMode: row.previewMode as NotificationPreviewMode,
    sound: row.sound,
    mobileDelay: row.mobileDelay as MobileDelay,
    version: row.version,
  };
}

/** What a person's notifications are decided by: their settings and the zone quiet hours read. */
export type PersonNotificationSettings = {
  settings: NotificationSettings;
  timeZone: string;
  /** The interface language a notification is written in. */
  language: string | null;
};

/**
 * A person's account notification settings (`user_notification_settings`, task #467): no row
 * reads as the defaults. A save names the version it was made from; any other is CONFLICT
 * (`notification-settings-version-conflict`, `details.currentVersion`), so a second device's edit
 * is never overwritten unseen: the page reads the settings again.
 */
export class NotificationSettingsStore {
  constructor(private readonly db: Client) {}

  async read(userId: string): Promise<PersonNotificationSettings> {
    return (await this.readMany([userId])).get(userId)!;
  }

  /** Every one of `userIds`, read in one query; an unknown id reads as the defaults in UTC. */
  async readMany(userIds: readonly string[]): Promise<Map<string, PersonNotificationSettings>> {
    const users = await this.db.user.findMany({
      where: { id: { in: [...userIds] } },
      select: {
        id: true,
        preferences: { select: { timeZone: true, language: true } },
        notificationSettings: { select: ROW },
      },
    });
    const byId = new Map(users.map((user) => [user.id, user]));
    return new Map(
      userIds.map((userId) => {
        const user = byId.get(userId);
        return [
          userId,
          {
            settings: settingsOf(user?.notificationSettings),
            timeZone: user?.preferences?.timeZone || "UTC",
            language: user?.preferences?.language ?? null,
          },
        ];
      }),
    );
  }

  async update(
    userId: string,
    { expectedVersion, changes }: NotificationSettingsChange,
    now: Date,
  ): Promise<NotificationSettings> {
    const pausedUntil =
      changes.pausedUntil === undefined
        ? undefined
        : changes.pausedUntil === null
          ? null
          : new Date(changes.pausedUntil);
    if (pausedUntil && pausedUntil.getTime() - now.getTime() > MAX_PAUSE_MS)
      throw new AppError("INVALID_INPUT", { errorId: NOTIFICATION_PAUSE_TOO_LONG });
    const data = {
      ...(pausedUntil !== undefined && { pausedUntil }),
      ...(changes.quietHours && {
        quietHoursEnabled: changes.quietHours.enabled,
        quietStartMinute: changes.quietHours.startMinute,
        quietEndMinute: changes.quietHours.endMinute,
      }),
      ...(changes.previewMode && { previewMode: changes.previewMode }),
      ...(changes.sound !== undefined && { sound: changes.sound }),
      ...(changes.mobileDelay && { mobileDelay: changes.mobileDelay }),
    };
    if (expectedVersion === 0) {
      try {
        const created = await this.db.userNotificationSettings.create({
          data: { userId, ...data, version: 1 },
          select: ROW,
        });
        return settingsOf(created);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        throw await this.conflict(userId);
      }
    }
    const { count } = await this.db.userNotificationSettings.updateMany({
      where: { userId, version: expectedVersion },
      data: { ...data, version: { increment: 1 } },
    });
    if (count === 0) throw await this.conflict(userId);
    return (await this.read(userId)).settings;
  }

  private async conflict(userId: string) {
    const { settings } = await this.read(userId);
    return new AppError("CONFLICT", {
      errorId: NOTIFICATION_SETTINGS_VERSION_CONFLICT,
      details: { currentVersion: settings.version },
    });
  }
}

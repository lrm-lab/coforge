import type { Prisma, PrismaClient } from "#src/generated/prisma/client";

import { validateTimeZone } from "#src/lib/dates";
import { AppError } from "#src/lib/app-error";
import { isTimeFormat } from "#src/lib/time-format";

/** The settings every page reads together, as stored: one row, so one read. */
export type StoredUserPreferences = {
  timeZone: string | null;
  timeFormat: string | null;
};

export type UserPreferencesRepository = {
  read(userId: string): Promise<StoredUserPreferences>;
  setTimeZone(userId: string, timeZone: string | null): Promise<string | null>;
  getBrowserNotificationsEnabled(userId: string): Promise<boolean>;
  setBrowserNotificationsEnabled(userId: string, enabled: boolean): Promise<boolean>;
  setTimeFormat(userId: string, timeFormat: string | null): Promise<string | null>;
};

type PreferenceValues = Omit<
  Prisma.UserPreferenceUncheckedCreateInput,
  "userId" | "createdAt" | "updatedAt"
>;

export class PrismaUserPreferencesRepository implements UserPreferencesRepository {
  constructor(private readonly db: PrismaClient) {}

  /** A user without a row has never saved a preference, so every setting reads as its default. */
  private row(userId: string) {
    return this.db.userPreference.findUnique({ where: { userId } });
  }

  async read(userId: string) {
    const row = await this.row(userId);
    return {
      timeZone: row?.timeZone ?? null,
      timeFormat: row?.timeFormat ?? null,
    };
  }

  private write(userId: string, data: PreferenceValues) {
    return this.db.userPreference.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  }

  async setTimeZone(userId: string, timeZone: string | null) {
    return (await this.write(userId, { timeZone })).timeZone;
  }

  async getBrowserNotificationsEnabled(userId: string) {
    return (await this.row(userId))?.browserNotificationsEnabled ?? false;
  }

  async setBrowserNotificationsEnabled(userId: string, enabled: boolean) {
    return (
      (await this.write(userId, { browserNotificationsEnabled: enabled }))
        .browserNotificationsEnabled === true
    );
  }

  async setTimeFormat(userId: string, timeFormat: string | null) {
    return (await this.write(userId, { timeFormat })).timeFormat;
  }
}

export class UserPreferences {
  constructor(private readonly repository: UserPreferencesRepository) {}

  /** The time zone and time format, read together. */
  async read(userId: string) {
    const stored = await this.repository.read(userId);
    return {
      timeZone: stored.timeZone,
      timeFormat: isTimeFormat(stored.timeFormat) ? stored.timeFormat : null,
    };
  }

  async set(userId: string, timeZone: string | null) {
    return this.repository.setTimeZone(
      userId,
      timeZone === null ? null : validateTimeZone(timeZone),
    );
  }

  getBrowserNotificationsEnabled(userId: string) {
    return this.repository.getBrowserNotificationsEnabled(userId);
  }

  setBrowserNotificationsEnabled(userId: string, enabled: boolean) {
    return this.repository.setBrowserNotificationsEnabled(userId, enabled);
  }

  async setTimeFormat(userId: string, timeFormat: string | null) {
    if (timeFormat !== null && !isTimeFormat(timeFormat)) throw new AppError("INVALID_INPUT");
    return this.repository.setTimeFormat(userId, timeFormat);
  }
}

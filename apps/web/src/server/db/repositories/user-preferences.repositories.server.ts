import type { Prisma } from "#src/generated/prisma/client";

import { validateTimeZone } from "#src/lib/dates";
import { AppError } from "#src/lib/app-error";
import { isTimeFormat } from "#src/lib/time-format";
import { isPersonRole, type PersonRole } from "#src/features/onboarding/person-role";
import type { DatabaseScope } from "#src/server/db/transaction.server";

/** The settings every page reads together, as stored: one row, so one read. */
export type StoredUserPreferences = {
  timeZone: string | null;
  timeFormat: string | null;
  language: string | null;
};

/** The interface languages the server renders outbound text in. */
export const USER_LANGUAGES = ["en", "zh-CN"] as const;
export type UserLanguage = (typeof USER_LANGUAGES)[number];

export type UserPreferencesRepository = {
  read(userId: string): Promise<StoredUserPreferences>;
  setTimeZone(userId: string, timeZone: string | null): Promise<string | null>;
  getBrowserNotificationsEnabled(userId: string): Promise<boolean>;
  setBrowserNotificationsEnabled(userId: string, enabled: boolean): Promise<boolean>;
  setTimeFormat(userId: string, timeFormat: string | null): Promise<string | null>;
  setLanguage(userId: string, language: UserLanguage | null): Promise<string | null>;
  setRole(userId: string, role: PersonRole | null): Promise<string | null>;
};

type PreferenceValues = Omit<
  Prisma.UserPreferenceUncheckedCreateInput,
  "userId" | "createdAt" | "updatedAt"
>;

export class PrismaUserPreferencesRepository implements UserPreferencesRepository {
  /** A transaction's client works too, so a caller can save a setting in its own transaction. */
  constructor(private readonly db: DatabaseScope) {}

  /** A user without a row has never saved a preference, so every setting reads as its default. */
  private row(userId: string) {
    return this.db.userPreference.findUnique({ where: { userId } });
  }

  async read(userId: string) {
    const row = await this.row(userId);
    return {
      timeZone: row?.timeZone ?? null,
      timeFormat: row?.timeFormat ?? null,
      language: row?.language ?? null,
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

  async setLanguage(userId: string, language: UserLanguage | null) {
    return (await this.write(userId, { language })).language;
  }

  async setRole(userId: string, role: PersonRole | null) {
    return (await this.write(userId, { role })).role;
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
      language: isUserLanguage(stored.language) ? stored.language : null,
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

  async setLanguage(userId: string, language: UserLanguage | null) {
    if (language !== null && !isUserLanguage(language)) throw new AppError("INVALID_INPUT");
    return this.repository.setLanguage(userId, language);
  }

  async setRole(userId: string, role: string | null) {
    if (role !== null && !isPersonRole(role)) throw new AppError("INVALID_INPUT");
    return this.repository.setRole(userId, role);
  }
}

export function isUserLanguage(value: unknown): value is UserLanguage {
  return USER_LANGUAGES.includes(value as UserLanguage);
}

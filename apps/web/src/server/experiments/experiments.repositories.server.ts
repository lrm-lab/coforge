import type { PrismaClient } from "#src/generated/prisma/client";

import type { ExperimentsRepository } from "./experiments.server";

export class PrismaExperimentsRepository implements ExperimentsRepository {
  constructor(private readonly db: PrismaClient) {}

  async read(userId: string) {
    const row = await this.db.userPreference.findUnique({
      where: { userId },
      select: { experiments: true },
    });
    const stored = row?.experiments;
    return stored && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, boolean>)
      : {};
  }

  /** One statement, so two tabs setting different keys never overwrite each other. */
  async write(userId: string, key: string, enabled: boolean) {
    await this.db.$executeRaw`
      INSERT INTO user_preferences ("userId", experiments, "createdAt", "updatedAt")
      VALUES (${userId}::uuid, jsonb_build_object(${key}::text, ${enabled}::boolean), NOW(), NOW())
      ON CONFLICT ("userId") DO UPDATE
        SET experiments = COALESCE(user_preferences.experiments, '{}'::jsonb)
              || jsonb_build_object(${key}::text, ${enabled}::boolean),
            "updatedAt" = NOW()`;
  }
}

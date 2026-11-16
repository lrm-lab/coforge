import type { DatabaseScope } from "#src/server/db/transaction.server";

export async function readPlatformMemoryPreference(db: DatabaseScope, userId: string) {
  const row = await db.userPreference.findUnique({
    where: { userId },
    select: { platformMemoryEnabled: true },
  });
  return row?.platformMemoryEnabled ?? true;
}

export async function savePlatformMemoryPreference(
  db: DatabaseScope,
  userId: string,
  enabled: boolean,
) {
  const row = await db.userPreference.upsert({
    where: { userId },
    create: { userId, platformMemoryEnabled: enabled },
    update: { platformMemoryEnabled: enabled },
    select: { platformMemoryEnabled: true },
  });
  return row.platformMemoryEnabled ?? true;
}

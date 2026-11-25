import type { PrismaClient } from "#src/generated/prisma/client";
import { WHATS_NEW_ENTRIES } from "../src/features/whats-new/whats-new-entries";
import { DEV_BROWSER_USER } from "../src/server/auth/dev-skip-auth.server";

/**
 * Upserts the dev/E2E browser user past first sign-in and marks released What's New entries as
 * dismissed so default E2E runs start from a deterministic baseline; `e2e-whats-new.e2e.ts`
 * explicitly resets `whatsNewDismissed` when exercising What's New.
 */
export async function seedDevBrowserUser(db: PrismaClient): Promise<void> {
  await db.user.upsert({
    where: { id: DEV_BROWSER_USER.id },
    create: {
      id: DEV_BROWSER_USER.id,
      username: DEV_BROWSER_USER.username,
      displayName: DEV_BROWSER_USER.name,
      // Past first sign-in: the dev session opens the Workspace, not the name step.
      welcomedAt: new Date(),
    },
    update: {
      username: DEV_BROWSER_USER.username,
      displayName: DEV_BROWSER_USER.name,
      welcomedAt: new Date(),
    },
  });
  await dismissSeededWhatsNew(db, [DEV_BROWSER_USER.id]);
}

export async function dismissSeededWhatsNew(
  db: PrismaClient,
  userIds: readonly string[],
): Promise<void> {
  const allWhatsNew = WHATS_NEW_ENTRIES.map((entry) => entry.id);
  for (const userId of userIds) {
    await db.userPreference.upsert({
      where: { userId },
      create: { userId, whatsNewDismissed: allWhatsNew },
      update: { whatsNewDismissed: allWhatsNew },
    });
  }
}

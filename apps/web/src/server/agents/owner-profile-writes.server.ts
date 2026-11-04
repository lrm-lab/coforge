import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import type { UserLanguage } from "#src/server/db/repositories/user-preferences.repositories.server";
import {
  PrismaUserPreferencesRepository,
  UserPreferences,
} from "#src/server/db/repositories/user-preferences.repositories.server";
import { PrismaUserProfileRepository } from "#src/server/db/repositories/user-profile.repositories.server";
import { ownerNamingOf, renameOwnerAgents } from "./owner-agent-rename.server";

/**
 * The owner-profile writes that also rename the owner's assistants (task #495). Each runs in one
 * transaction: read the owner's naming before the change, make the change, then rename the
 * personal and weekly-report assistants whose name still follows the owner. Kept apart from the
 * Server Functions so the transaction and the rename are tested directly, not through the
 * TanStack middleware.
 */

/** Saves the person's interface language, then renames their owner-named assistants. */
export async function setLanguageAndRenameAssistants(
  db: PrismaClient,
  userId: string,
  language: UserLanguage | null,
): Promise<string | null> {
  return db.$transaction(async (tx) => {
    await lockUser(tx, userId);
    const before = await tx.user.findUnique({
      where: { id: userId },
      select: { username: true, displayName: true, preferences: { select: { language: true } } },
    });
    if (!before) throw new AppError("NOT_FOUND");
    const previous = ownerNamingOf(before);
    const saved = await new UserPreferences(new PrismaUserPreferencesRepository(tx)).setLanguage(
      userId,
      language,
    );
    await renameOwnerAgents(tx, userId, previous);
    return saved;
  });
}

/** Saves the person's display name and description, then renames their owner-named assistants. */
export async function saveProfileAndRenameAssistants(
  db: PrismaClient,
  userId: string,
  input: { displayName: string; description: string },
) {
  return db.$transaction(async (tx) => {
    await lockUser(tx, userId);
    const before = await tx.user.findUnique({
      where: { id: userId },
      select: { username: true, displayName: true, preferences: { select: { language: true } } },
    });
    if (!before) throw new AppError("NOT_FOUND");
    const previous = ownerNamingOf(before);
    const saved = await new PrismaUserProfileRepository(tx).set(userId, input);
    await renameOwnerAgents(tx, userId, previous);
    return saved;
  });
}

/** Locks the user's row for the transaction, so two concurrent profile or language writes to the
 * same person serialize: each reads the name the other left, and the rename's compare-and-swap
 * never races. */
function lockUser(tx: Prisma.TransactionClient, userId: string) {
  return tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
}

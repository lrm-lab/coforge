import type { PrismaClient } from "#src/generated/prisma/client";
import {
  displayNameUsernameBase,
  isFallbackUsername,
  prismaUsernameAllocator,
} from "./username-allocation.server";

/**
 * Replaces a new account's fallback username (`user`, `user-<n>`: what a sign-in that told us
 * nothing about the person was given) with one read from the display name they are confirming, and
 * returns the username to go on with. This is the one time a username changes: the person has not
 * confirmed a name yet (`welcomedAt` is null, enforced by the update itself), so no Workspace, message
 * or Login with CoForge consent has used the handle. An account that is already named, a username
 * from any other source, and a name that yields nothing usable all keep theirs.
 *
 * Best effort, and never the first sign-in's business: any failure is logged without the name or
 * the username and the current username is returned. Run it outside a transaction, as a taken
 * name aborts one and the allocator's retry needs the connection back.
 */
export async function renameFallbackUsername(
  db: PrismaClient,
  user: { id: string; username: string },
  displayName: string,
): Promise<string> {
  if (!isFallbackUsername(user.username)) return user.username;
  try {
    const base = await displayNameUsernameBase(displayName);
    if (!base) return user.username;
    return await prismaUsernameAllocator(db).allocate(base, async (username) => {
      const { count } = await db.user.updateMany({
        where: { id: user.id, username: user.username, welcomedAt: null },
        data: { username },
      });
      return count === 1 ? username : user.username;
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    console.error(
      JSON.stringify({
        event: "auth.username_rename_failed",
        errorType: error instanceof Error ? error.name : "non_error",
        ...(typeof code === "string" ? { errorCode: code } : {}),
      }),
    );
    return user.username;
  }
}

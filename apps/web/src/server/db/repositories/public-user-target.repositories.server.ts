import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { STORED_USERNAME_SOURCE } from "#src/lib/username-grammar";

const PUBLIC_USERNAME_TARGET = new RegExp(`^@${STORED_USERNAME_SOURCE}$`);

/** The id of the person an Agent's `@username` target names (the part before any `:`). */
export async function userIdOfUsernameTarget(
  db: Pick<PrismaClient, "user">,
  parentTarget: string,
): Promise<string> {
  if (!PUBLIC_USERNAME_TARGET.test(parentTarget)) throw new AppError("INVALID_TARGET");
  const user = await db.user.findUnique({
    where: { username: parentTarget.slice(1) },
    select: { id: true },
  });
  if (!user) throw new AppError("TARGET_NOT_ACCESSIBLE");
  return user.id;
}

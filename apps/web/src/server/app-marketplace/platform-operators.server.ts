import type { PrismaClient } from "#src/generated/prisma/client";

/**
 * Makes the one person whose sign-in email is `email` an `app_reviewer`, the platform role that
 * decides Marketplace review requests. This is how the first operator is created (the grant
 * script `scripts/grant-platform-operator.ts`); it is idempotent and keeps an existing grant's
 * time. An email that matches no person, or more than one (it is not unique), grants nothing.
 */
export async function grantPlatformOperator(
  db: PrismaClient,
  email: string,
): Promise<"granted" | "already" | "no-user" | "ambiguous"> {
  const users = await db.user.findMany({
    where: { email: { equals: email.trim(), mode: "insensitive" } },
    select: { id: true, platformOperator: { select: { userId: true } } },
    take: 2,
  });
  if (users.length === 0) return "no-user";
  if (users.length > 1) return "ambiguous";
  const [user] = users;
  if (user!.platformOperator) return "already";
  await db.platformOperator.create({ data: { userId: user!.id, role: "app_reviewer" } });
  return "granted";
}

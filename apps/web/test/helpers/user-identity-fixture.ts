import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { UserIdentityRepository } from "#src/server/auth/user-identity.repository.server";

/**
 * A scratch PostgreSQL `UserIdentityRepository` for the login-identity integration tests:
 * `login` resolves one provider subject, the `stored*` readers return what the repository wrote,
 * `userWrites` counts the `UPDATE "public"."users"` statements it issued, and `teardown` removes
 * the Users it made. Callers skip unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
export type UserIdentityLoginProfile = {
  email?: string | null;
  emailVerified?: boolean;
  phone?: string | null;
  phoneVerified?: boolean;
  preferredUsername?: string | null;
  name?: string | null;
  nickname?: string | null;
};

export async function userIdentityFixture() {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: connectionString! }),
    log: [{ emit: "event", level: "query" }],
  });
  const statements: string[] = [];
  db.$on("query", (event) => statements.push(event.query));
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const login = async (subject: string, profile?: UserIdentityLoginProfile) => {
    const user = await new UserIdentityRepository(db).resolve("authing", subject, profile);
    userIds.push(user.id);
    return user;
  };
  const storedEmail = async (userId: string) =>
    (await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })).email;
  const storedPhone = async (userId: string) =>
    (await db.user.findUniqueOrThrow({ where: { id: userId }, select: { phone: true } })).phone;
  const storedVerification = async (userId: string) =>
    db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { emailVerified: true, phoneVerified: true },
    });
  const userWrites = () =>
    statements.filter((query) => query.startsWith('UPDATE "public"."users"'));
  const teardown = async () => {
    await db.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    await db.$disconnect();
  };
  return {
    db,
    suffix,
    userIds,
    login,
    storedEmail,
    storedPhone,
    storedVerification,
    userWrites,
    teardown,
  };
}

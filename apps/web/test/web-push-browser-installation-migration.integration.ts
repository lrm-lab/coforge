import { expect, test } from "bun:test";
import { Client } from "pg";

const databaseUrl = Bun.env.MIGRATION_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("MIGRATION_TEST_DATABASE_URL is required");
const migrations = new URL("../prisma/migrations/", import.meta.url);

test("browser installation migration preserves unbound subscriptions and enforces uniqueness per user", async () => {
  const schema = `push_installation_${crypto.randomUUID().replaceAll("-", "")}`;
  const client = new Client({ connectionString: databaseUrl });
  const firstUser = crypto.randomUUID();
  const secondUser = crypto.randomUUID();
  const installation = crypto.randomUUID();
  const legacyOne = crypto.randomUUID();
  const legacyTwo = crypto.randomUUID();
  const otherUser = crypto.randomUUID();
  const stillUnbound = crypto.randomUUID();
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query('CREATE TABLE "users" ("id" UUID PRIMARY KEY)');
    await client.query('INSERT INTO "users" ("id") VALUES ($1), ($2)', [firstUser, secondUser]);

    for (const migration of [
      "20260907000000_web_push_notifications",
      "20261104110100_web_push_subscription_devices",
    ]) {
      await client.query(await Bun.file(new URL(`${migration}/migration.sql`, migrations)).text());
    }

    const insertUnbound = (id: string, userId: string, name: string) =>
      client.query(
        `INSERT INTO "web_push_subscriptions"
            ("id", "userId", "endpoint", "p256dh", "auth", "updatedAt")
           VALUES ($1, $2, $3, 'test-p256dh', 'test-auth', now())`,
        [id, userId, `https://push.example.test/${name}`],
      );
    await insertUnbound(legacyOne, firstUser, "old-one");
    await insertUnbound(legacyTwo, firstUser, "old-two");
    await insertUnbound(otherUser, secondUser, "other-user");

    for (const migration of [
      "20261122204800_web_push_browser_installation",
      "20261122204801_web_push_browser_installation_key",
    ]) {
      await client.query(await Bun.file(new URL(`${migration}/migration.sql`, migrations)).text());
    }

    await insertUnbound(stillUnbound, firstUser, "old-client-after-migration");
    expect(
      (
        await client.query(
          `SELECT "endpoint", "browserInstallationId"
             FROM "web_push_subscriptions" ORDER BY "endpoint"`,
        )
      ).rows,
    ).toEqual(
      ["old-client-after-migration", "old-one", "old-two", "other-user"].map((name) => ({
        endpoint: `https://push.example.test/${name}`,
        browserInstallationId: null,
      })),
    );

    const bind = (id: string, value: string) =>
      client.query(
        `UPDATE "web_push_subscriptions" SET "browserInstallationId" = $1
           WHERE "id" = $2 RETURNING "browserInstallationId"`,
        [value, id],
      );
    expect((await bind(legacyOne, installation)).rows).toEqual([
      { browserInstallationId: installation },
    ]);
    await expect(bind(legacyTwo, installation)).rejects.toMatchObject({
      code: "23505",
      constraint: "web_push_subscriptions_userId_browserInstallationId_key",
    });
    expect((await bind(otherUser, installation)).rows).toEqual([
      { browserInstallationId: installation },
    ]);
    await expect(bind(legacyTwo, "invalid-uuid")).rejects.toMatchObject({ code: "22P02" });
  } finally {
    try {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await client.end();
    }
  }
});

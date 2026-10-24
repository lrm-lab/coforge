import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { completeFirstSignIn } from "#src/server/auth/first-sign-in.server";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({
    data: { displayName: `fsi-${suffix}`, username: `fsi-${suffix}` },
  });
  const memberships = () =>
    db.workspaceMembership.findMany({
      where: { userId: user.id },
      include: { workspace: true },
    });
  const teardown = async () => {
    const owned = await memberships();
    await db.workspace
      .deleteMany({ where: { id: { in: owned.map((row) => row.workspaceId) } } })
      .catch(() => {});
    await db.user.deleteMany({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  };
  return { db, user, memberships, teardown };
}

test("first sign-in locks its User before a second tab can choose a different Workspace name", async () => {
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const { db, user, memberships, teardown } = await setup();
  const url = (label: string) => {
    const value = new URL(connectionString!);
    value.searchParams.set("application_name", label);
    return value.toString();
  };
  const firstLabel = `fsi-first-${user.id}`;
  const secondLabel = `fsi-second-${user.id}`;
  const firstDb = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url(firstLabel) }),
  });
  const secondDb = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url(secondLabel) }),
  });
  const blocker = new Pool({ connectionString });
  const lock = await blocker.connect();
  const calls: Promise<unknown>[] = [];
  const waitingQuery = async (label: string) => {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const [row] = await db.$queryRaw<{ query: string }[]>`
          SELECT query FROM pg_stat_activity
          WHERE application_name = ${label} AND wait_event_type = 'Lock'`;
      if (row) return row.query;
      if (Date.now() > deadline) throw new Error(`No observable lock wait for ${label}`);
      await Bun.sleep(10);
    }
  };
  try {
    await lock.query("BEGIN; LOCK TABLE workspaces IN SHARE MODE");
    calls.push(
      completeFirstSignIn({ db: firstDb, user, displayName: "Ada Lovelace", acceptLanguage: "en" }),
    );
    await waitingQuery(firstLabel);
    calls.push(
      completeFirstSignIn({ db: secondDb, user, displayName: "Ada King", acceptLanguage: "en" }),
    );
    expect(await waitingQuery(secondLabel)).toMatch(/users[\s\S]*FOR UPDATE/i);
    const beforeCommit = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(beforeCommit.welcomedAt).toBeNull();
    expect(await memberships()).toEqual([]);
    await lock.query("ROLLBACK");
    await Promise.all(calls);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).displayName).toBe(
      "Ada Lovelace",
    );
    expect((await memberships()).map((row) => row.workspace.name)).toEqual([
      "Ada Lovelace's Workspace",
    ]);
  } finally {
    await lock.query("ROLLBACK");
    await Promise.allSettled(calls);
    lock.release();
    await blocker.end();
    await firstDb.$disconnect();
    await secondDb.$disconnect();
    await teardown();
  }
}, 20_000);

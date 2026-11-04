import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import type { WhatsNewEntryData } from "#src/features/whats-new/whats-new-entries";
import { WhatsNew, whatsNewClock } from "#src/server/whats-new/whats-new.server";

/**
 * The "What's new" card's server side against real PostgreSQL (task #493): who sees which entry,
 * dismissals kept on the person's preferences, and entries that wait on an experiment.
 */
const connectionString = Bun.env.PREFERENCES_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;

const entries: WhatsNewEntryData[] = [
  {
    id: "documents",
    releasedAt: "2026-11-04T07:00:00Z",
    experiment: "artifacts",
  },
  { id: "task-labels", releasedAt: "2026-11-04T07:01:00Z" },
];
const now = () => new Date("2026-11-05T00:00:00Z");

async function setup() {
  if (!connectionString) throw new Error("PREFERENCES_TEST_DATABASE_URL or DATABASE_URL is unset");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const handle = crypto.randomUUID().slice(0, 8);
  const person = (name: string, createdAt: Date) =>
    db.user.create({
      data: {
        displayName: `${name}-${handle}`,
        username: `wn-${name}-${handle}`,
        createdAt,
      },
    });
  const veteran = await person("veteran", new Date("2026-10-01T00:00:00Z"));
  const newcomer = await person("newcomer", new Date("2026-11-04T08:00:00Z"));
  const workspace = await db.workspace.create({
    data: {
      slug: `whats-new-${handle}`,
      name: "What's new",
      experiments: { artifacts: true },
      members: {
        create: [{ userId: veteran.id, role: "owner" }, { userId: newcomer.id }],
      },
    },
  });
  const whatsNew = new WhatsNew(db, entries, now);
  const cleanup = async () => {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.deleteMany({
      where: { id: { in: [veteran.id, newcomer.id] } },
    });
    await db.$disconnect();
  };
  return {
    db,
    whatsNew,
    workspaceId: workspace.id,
    veteran,
    newcomer,
    cleanup,
  };
}

test("someone who joined after the release sees neither entry", async () => {
  const { whatsNew, workspaceId, newcomer, cleanup } = await setup();
  try {
    expect(await whatsNew.pending(newcomer.id, workspaceId)).toEqual([]);
  } finally {
    await cleanup();
  }
});

test("dismissing one shows the next, and the dismissal follows the person to another device", async () => {
  const { db, whatsNew, workspaceId, veteran, cleanup } = await setup();
  try {
    expect(await whatsNew.pending(veteran.id, workspaceId)).toEqual(["documents", "task-labels"]);
    await whatsNew.dismiss(veteran.id, "documents");
    // Twice is still once.
    await whatsNew.dismiss(veteran.id, "documents");
    expect(await whatsNew.pending(veteran.id, workspaceId)).toEqual(["task-labels"]);
    // Another device is another reader of the same stored row.
    const elsewhere = new WhatsNew(db, entries, now);
    expect(await elsewhere.pending(veteran.id, workspaceId)).toEqual(["task-labels"]);
    expect(
      (
        await db.userPreference.findUniqueOrThrow({
          where: { userId: veteran.id },
        })
      ).whatsNewDismissed,
    ).toEqual(["documents"]);
  } finally {
    await cleanup();
  }
});

test("documents wait while the experiment is off, uncounted, and show once it is on", async () => {
  const { db, whatsNew, workspaceId, veteran, cleanup } = await setup();
  try {
    await db.workspace.update({
      where: { id: workspaceId },
      data: { experiments: {} },
    });
    expect(await whatsNew.pending(veteran.id, workspaceId)).toEqual(["task-labels"]);
    await whatsNew.dismiss(veteran.id, "task-labels");
    expect(await whatsNew.pending(veteran.id, workspaceId)).toEqual([]);
    await db.workspace.update({
      where: { id: workspaceId },
      data: { experiments: { artifacts: true } },
    });
    expect(await whatsNew.pending(veteran.id, workspaceId)).toEqual(["documents"]);
  } finally {
    await cleanup();
  }
});

test("an id no build knows is refused", async () => {
  const { whatsNew, veteran, cleanup } = await setup();
  try {
    await expect(whatsNew.dismiss(veteran.id, "no-such-entry")).rejects.toThrow();
  } finally {
    await cleanup();
  }
});

test("the E2E clock is honoured only where the dev sign-in bypass is", () => {
  const pinned = "2026-11-05T00:00:00Z";
  expect(
    whatsNewClock({
      NODE_ENV: "development",
      COFORGE_DEV_SKIP_AUTH: "1",
      COFORGE_E2E_WHATS_NEW_NOW: pinned,
    })().toISOString(),
  ).toBe("2026-11-05T00:00:00.000Z");
  const production = whatsNewClock({
    NODE_ENV: "production",
    COFORGE_DEV_SKIP_AUTH: "1",
    COFORGE_E2E_WHATS_NEW_NOW: pinned,
  })();
  expect(production.toISOString()).not.toBe("2026-11-05T00:00:00.000Z");
});

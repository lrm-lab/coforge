import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  applyLinkAccessMigration,
  planLinkAccessMigration,
  rollbackLinkAccessMigration,
} from "#src/server/artifacts/artifact-link-access-migration.server";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";

let f: CommentsFixture;

beforeAll(async () => {
  f = await commentsFixture("lm");
});
afterAll(() => f.cleanup());

const link = (artifactId: string) =>
  f.db.artifactPublicLink.create({
    data: { artifactId, token: `tok-${crypto.randomUUID()}`, createdByUserId: f.alice },
  });
const tier = async (id: string) =>
  (await f.db.artifact.findUniqueOrThrow({ where: { id }, select: { access: true } })).access;
const recordFor = async (artifactId: string) => {
  const journal = await applyLinkAccessMigration(f.db, () => {});
  return journal.records.find((record) => record.artifactId === artifactId);
};
const eventCount = (artifactId: string) =>
  f.db.artifactAccessEvent.count({ where: { artifactId } });
const migrateOne = async (artifactId: string) => {
  const journal = await applyLinkAccessMigration(f.db, () => {});
  const record = journal.records.find((entry) => entry.artifactId === artifactId);
  if (!record) throw new Error(`the migration recorded nothing for ${artifactId}`);
  return { version: 1 as const, appliedAt: journal.appliedAt, records: [record] };
};

test("every artifact with a live link becomes link-tier and the journal explains each change", async () => {
  const before = await planLinkAccessMigration(f.db);
  const shared = await f.make("Conversation link");
  const workspace = await f.make("Workspace link");
  await f.db.artifact.update({ where: { id: workspace }, data: { access: "workspace" } });
  const unlinked = await f.make("No link");
  const publicLink = await link(shared);
  await link(workspace);
  const after = await planLinkAccessMigration(f.db);
  expect(after.byFrom.conversation - before.byFrom.conversation).toBe(1);
  expect(after.byFrom.workspace - before.byFrom.workspace).toBe(1);

  const updatedAt = (
    await f.db.artifact.findUniqueOrThrow({ where: { id: shared }, select: { updatedAt: true } })
  ).updatedAt;
  const journal = await applyLinkAccessMigration(f.db, () => {});
  expect(journal.version).toBe(1);
  const applied = journal.records.filter((record) =>
    [shared, workspace].includes(record.artifactId),
  );
  expect(Object.fromEntries(applied.map((record) => [record.artifactId, record.from]))).toEqual({
    [shared]: "conversation",
    [workspace]: "workspace",
  });
  expect(await tier(shared)).toBe("link");
  expect(await tier(workspace)).toBe("link");
  expect(await tier(unlinked)).toBe("conversation");
  expect(applied[0]?.linkIds).toEqual([publicLink.id]);
  expect(applied[0]?.eventCount).toBe(1);
  expect(JSON.stringify(journal)).not.toContain(publicLink.token);

  const events = await f.db.artifactAccessEvent.findMany({
    where: { artifactId: { in: [shared, workspace] } },
    orderBy: { createdAt: "asc" },
  });
  expect(events.map((event) => [event.artifactId, event.from, event.to])).toEqual([
    [shared, "conversation", "link"],
    [workspace, "workspace", "link"],
  ]);

  const afterMigration = await f.db.artifact.findUniqueOrThrow({
    where: { id: shared },
    select: { updatedAt: true },
  });
  expect(afterMigration.updatedAt).toEqual(updatedAt);
});

test("a re-run migrates nothing, adds no event, and leaves the migrated rows alone", async () => {
  const shared = await f.make("Already migrated");
  await link(shared);
  await applyLinkAccessMigration(f.db, () => {});
  const before = (await planLinkAccessMigration(f.db)).alreadyLink;

  const again = await applyLinkAccessMigration(f.db, () => {});
  expect(again.records).toEqual([]);
  expect((await planLinkAccessMigration(f.db)).alreadyLink).toBeGreaterThanOrEqual(before);
  expect(await eventCount(shared)).toBe(1);
  expect(await tier(shared)).toBe("link");
});

test("an artifact whose links are all revoked, or that is deleted, is left alone", async () => {
  const revoked = await f.make("Revoked link");
  const gone = await f.make("Deleted artifact");
  const deadLink = await link(revoked);
  await f.db.artifactPublicLink.update({
    where: { id: deadLink.id },
    data: { revokedAt: new Date() },
  });
  await link(gone);
  await f.db.artifact.update({ where: { id: gone }, data: { deletedAt: new Date() } });

  const journal = await applyLinkAccessMigration(f.db, () => {});
  expect(journal.records.some((record) => record.artifactId === revoked)).toBe(false);
  expect(journal.records.some((record) => record.artifactId === gone)).toBe(false);
  expect(await tier(revoked)).toBe("conversation");
  expect(await tier(gone)).toBe("conversation");
});

test("rollback restores the original tier, keeps its link live, and runs only once", async () => {
  const shared = await f.make("Rollback me");
  await link(shared);
  const journal = await migrateOne(shared);

  expect(await rollbackLinkAccessMigration(f.db, journal)).toEqual([]);
  expect(await tier(shared)).toBe("conversation");
  const live = await f.db.artifactPublicLink.findMany({ where: { artifactId: shared } });
  expect(live.map((row) => row.revokedAt)).toEqual([null]);
  const last = await f.db.artifactAccessEvent.findFirstOrThrow({
    where: { artifactId: shared },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  expect([last.from, last.to]).toEqual(["link", "conversation"]);

  const count = await eventCount(shared);
  expect(await rollbackLinkAccessMigration(f.db, journal)).toEqual([shared]);
  expect(await tier(shared)).toBe("conversation");
  expect(await eventCount(shared)).toBe(count);
});

test("rollback skips a row a person changed, whose link moved, or whose history moved", async () => {
  const retiered = await f.make("Changed by hand");
  const revoke = await f.make("Link revoked after migrate");
  const relink = await f.make("Link replaced after migrate");
  const touched = await f.make("New access event after migrate");
  for (const id of [retiered, revoke, relink, touched]) await link(id);
  const journal = await applyLinkAccessMigration(f.db, () => {});
  const entries = journal.records.filter((entry) =>
    [retiered, revoke, relink, touched].includes(entry.artifactId),
  );
  expect(entries.length).toBe(4);

  await f.db.artifact.update({ where: { id: retiered }, data: { access: "workspace" } });
  await f.db.artifactPublicLink.updateMany({
    where: { artifactId: revoke },
    data: { revokedAt: new Date() },
  });
  await f.db.artifactPublicLink.updateMany({
    where: { artifactId: relink },
    data: { revokedAt: new Date() },
  });
  await link(relink);
  await f.db.artifactAccessEvent.create({
    data: { artifactId: touched, from: "link", to: "link" },
  });

  const skipped = await rollbackLinkAccessMigration(f.db, { ...journal, records: entries });
  for (const id of [retiered, revoke, relink, touched]) expect(skipped).toContain(id);
  expect(await tier(retiered)).toBe("workspace");
  expect(await tier(revoke)).toBe("link");
  expect(await tier(relink)).toBe("link");
  expect(await tier(touched)).toBe("link");
  const revokedLink = await f.db.artifactPublicLink.findFirstOrThrow({
    where: { artifactId: revoke },
  });
  expect(revokedLink.revokedAt).toBeInstanceOf(Date);
});

test("rollback skips a row whose access event landed late from an earlier transaction", async () => {
  const late = await f.make("Late commit");
  await link(late);
  const journal = await migrateOne(late);
  await f.db.artifactAccessEvent.create({
    data: {
      artifactId: late,
      from: "conversation",
      to: "workspace",
      createdAt: new Date(Date.now() - 60_000),
    },
  });

  expect(await rollbackLinkAccessMigration(f.db, journal)).toEqual([late]);
  expect(await tier(late)).toBe("link");
});

test("rollback skips a row deleted after the migration", async () => {
  const gone = await f.make("Deleted after migrate");
  await link(gone);
  const journal = await migrateOne(gone);
  await f.db.artifact.update({ where: { id: gone }, data: { deletedAt: new Date() } });

  expect(await rollbackLinkAccessMigration(f.db, journal)).toEqual([gone]);
  expect(await tier(gone)).toBe("link");
});

test("the journal names the record the migration wrote, and nothing else", async () => {
  const shared = await f.make("Journal shape");
  await link(shared);
  const record = await recordFor(shared);
  if (!record) throw new Error("the migration recorded nothing for the journal test");
  expect(record).toMatchObject({ artifactId: shared, from: "conversation", eventCount: 1 });
  const events = await f.db.artifactAccessEvent.findMany({ where: { artifactId: shared } });
  expect(events.map((event) => event.id)).toEqual([record.eventId]);
});

test("a journal write that fails inside the transaction leaves the row and its links as they were", async () => {
  const shared = await f.make("Journal write fails");
  const publicLink = await link(shared);
  const before = await f.db.artifact.findUniqueOrThrow({
    where: { id: shared },
    select: { access: true, updatedAt: true },
  });
  await expect(
    applyLinkAccessMigration(f.db, async (entry) => {
      if (entry.artifactId === shared) throw new Error("journal write failed");
    }),
  ).rejects.toThrow("journal write failed");

  const after = await f.db.artifact.findUniqueOrThrow({
    where: { id: shared },
    select: { access: true, updatedAt: true },
  });
  expect(after).toEqual(before);
  expect(await eventCount(shared)).toBe(0);
  const links = await f.db.artifactPublicLink.findMany({ where: { artifactId: shared } });
  expect(links.map((row) => row.id)).toEqual([publicLink.id]);
});

test("rollback skips a record whose transaction never committed", async () => {
  const shared = await f.make("Record without a commit");
  await link(shared);
  const journal = {
    version: 1 as const,
    appliedAt: new Date().toISOString(),
    records: [
      {
        artifactId: shared,
        eventId: "019b0381-9999-7999-8999-999999999999",
        from: "conversation" as const,
        linkIds: [],
        eventCount: 1,
      },
    ],
  };
  expect(await rollbackLinkAccessMigration(f.db, journal)).toEqual([shared]);
  expect(await tier(shared)).toBe("conversation");
});

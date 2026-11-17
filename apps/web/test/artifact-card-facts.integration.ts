import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { backfillArtifactEntryFacts } from "#src/server/artifacts/artifact-entry-facts-backfill.server";
import {
  artifactDocumentsWorld,
  type ArtifactDocumentsWorld,
} from "./helpers/artifact-documents-world";

const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
let world: ArtifactDocumentsWorld;

beforeAll(async () => {
  world = await artifactDocumentsWorld(db, crypto.randomUUID().slice(0, 8));
});

afterAll(async () => {
  await world.cleanup();
  await db.$disconnect();
});

const reading = (userId: string) => ({ workspaceId: world.workspaceId, actor: { userId } });
const writing = (agentId: string) => ({ workspaceId: world.workspaceId, actor: { agentId } });

test("a card carries its entry's facts, kept from the current version; Markdown and HTML have none", async () => {
  const sheet = await world.documents.create(writing(world.writer), {
    conversationId: world.channelId,
    title: "Sales",
    manifest: await world.manifest(world.writer, {
      "sales.csv": "name,region\nAda,north\nLin,south\n",
    }),
  });
  expect(sheet.entryFacts).toEqual({
    sizeBytes: 32,
    rows: 2,
    columns: 2,
    columnNames: ["name", "region"],
  });
  const pushed = await world.documents.push(writing(world.writer), {
    artifactId: sheet.id,
    baseVersion: 1,
    manifest: await world.manifest(world.writer, { "notes.txt": "one\ntwo\n" }, "notes.txt"),
    idempotencyKey: crypto.randomUUID(),
  });
  expect(pushed).toMatchObject({ status: "created", number: 2 });
  const [card] = await world.documents.cards(reading(world.bob), [sheet.id]);
  expect(card?.entryFacts).toEqual({ sizeBytes: 8, lines: 2 });
  const doc = await world.documents.create(writing(world.writer), {
    conversationId: world.channelId,
    title: "Plain notes",
    manifest: await world.manifest(world.writer, { "notes.md": "# Hi\n" }),
  });
  expect(doc.entryFacts).toBeNull();
});

test("the entry-facts backfill fills cards made before facts were kept, and leaves Markdown alone", async () => {
  const older = await world.documents.create(writing(world.writer), {
    conversationId: world.channelId,
    title: "Old sheet",
    manifest: await world.manifest(world.writer, { "old.csv": "a,b,c\n1,2,3\n" }),
  });
  const notes = await world.documents.create(writing(world.writer), {
    conversationId: world.channelId,
    title: "Old notes",
    manifest: await world.manifest(world.writer, { "old.md": "# Old\n" }),
  });
  await db.artifact.updateMany({
    where: { id: { in: [older.id, notes.id] } },
    data: { entryFacts: Prisma.DbNull },
  });
  const dry = await backfillArtifactEntryFacts({
    db,
    documents: world.documents,
    dryRun: true,
    batchSize: 1,
  });
  expect(dry.pending).toBeGreaterThanOrEqual(1);
  expect((await world.documents.cards(reading(world.bob), [older.id]))[0]?.entryFacts).toBeNull();
  const applied = await backfillArtifactEntryFacts({
    db,
    documents: world.documents,
    dryRun: false,
    batchSize: 1,
  });
  expect(applied.failed).toBe(0);
  const [sheet, doc] = await world.documents.cards(reading(world.bob), [older.id, notes.id]);
  expect(sheet?.entryFacts).toEqual({
    sizeBytes: 12,
    rows: 1,
    columns: 3,
    columnNames: ["a", "b", "c"],
  });
  expect(doc?.entryFacts).toBeNull();
  expect(
    (
      await backfillArtifactEntryFacts({
        db,
        documents: world.documents,
        dryRun: true,
        batchSize: 1,
      })
    ).pending,
  ).toBe(0);
});

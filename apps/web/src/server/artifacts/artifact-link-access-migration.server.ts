import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { z } from "zod";
import type { ArtifactAccessTier, ArtifactTier } from "./artifact-access.server";

type Db = Pick<PrismaClient, "artifact" | "$transaction">;
type Tx = Prisma.TransactionClient;

const recordSchema = z.object({
  artifactId: z.uuid(),
  eventId: z.uuid(),
  from: z.enum(["conversation", "workspace"]),
  linkIds: z.array(z.uuid()),
  eventCount: z.number().int().nonnegative(),
});
const journalSchema = z.object({
  version: z.literal(1),
  appliedAt: z.string(),
  records: z.array(recordSchema),
});

export type LinkAccessMigrationRecord = z.infer<typeof recordSchema>;
export type LinkAccessMigrationJournal = z.infer<typeof journalSchema>;
export type LinkAccessMigrationPlan = {
  byFrom: Record<ArtifactTier, number>;
  alreadyLink: number;
};

export const parseLinkAccessMigrationRecord = (value: unknown) => recordSchema.parse(value);
export const parseLinkAccessMigrationJournal = (value: unknown) => journalSchema.parse(value);

const TIERS: ArtifactAccessTier[] = ["conversation", "workspace", "link"];
const TRANSACTION = { timeout: 30_000 };

const lockTier = async (tx: Tx, artifactId: string) => {
  const [row] = await tx.$queryRaw<Array<{ access: ArtifactAccessTier }>>`
    SELECT "access" FROM "artifacts"
    WHERE "id" = ${artifactId}::uuid AND "deletedAt" IS NULL
    FOR UPDATE`;
  return row?.access;
};

const liveLinkIds = async (tx: Tx, artifactId: string) =>
  (
    await tx.artifactPublicLink.findMany({
      where: { artifactId, revokedAt: null },
      select: { id: true },
      orderBy: { id: "asc" },
    })
  ).map((link) => link.id);

const sameIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

function linkedCandidates(db: Db, access: ArtifactAccessTier[]) {
  return db.artifact.findMany({
    where: { deletedAt: null, access: { in: access }, publicLinks: { some: { revokedAt: null } } },
    select: { id: true, access: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export async function planLinkAccessMigration(db: Db): Promise<LinkAccessMigrationPlan> {
  const plan: LinkAccessMigrationPlan = {
    byFrom: { conversation: 0, workspace: 0 },
    alreadyLink: 0,
  };
  for (const row of await linkedCandidates(db, TIERS)) {
    if (row.access === "link") plan.alreadyLink += 1;
    else if (row.access === "conversation" || row.access === "workspace")
      plan.byFrom[row.access] += 1;
  }
  return plan;
}

export async function applyLinkAccessMigration(
  db: Db,
  record: (entry: LinkAccessMigrationRecord) => Promise<void> | void,
): Promise<LinkAccessMigrationJournal> {
  const records: LinkAccessMigrationRecord[] = [];
  for (const { id } of await linkedCandidates(db, ["conversation", "workspace"])) {
    const applied = await db.$transaction(async (tx) => {
      const access = await lockTier(tx, id);
      if (access === undefined || access === "link") return undefined;
      const linkIds = await liveLinkIds(tx, id);
      if (linkIds.length === 0) return undefined;
      await tx.$executeRaw`UPDATE "artifacts" SET "access" = 'link' WHERE "id" = ${id}::uuid`;
      const event = await tx.artifactAccessEvent.create({
        data: { artifactId: id, from: access, to: "link" },
      });
      const eventCount = await tx.artifactAccessEvent.count({ where: { artifactId: id } });
      const entry = {
        artifactId: id,
        eventId: event.id,
        from: access,
        linkIds,
        eventCount,
      } satisfies LinkAccessMigrationRecord;
      await record(entry);
      return entry;
    }, TRANSACTION);
    if (!applied) continue;
    records.push(applied);
  }
  return { version: 1, appliedAt: new Date().toISOString(), records };
}

export async function rollbackLinkAccessMigration(
  db: Db,
  journal: LinkAccessMigrationJournal,
): Promise<string[]> {
  const skipped: string[] = [];
  for (const entry of journal.records) {
    const restored = await db.$transaction(async (tx) => {
      if ((await lockTier(tx, entry.artifactId)) !== "link") return false;
      const newest = await tx.artifactAccessEvent.findFirst({
        where: { artifactId: entry.artifactId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true },
      });
      const eventCount = await tx.artifactAccessEvent.count({
        where: { artifactId: entry.artifactId },
      });
      if (newest?.id !== entry.eventId || eventCount !== entry.eventCount) return false;
      if (!sameIds(await liveLinkIds(tx, entry.artifactId), entry.linkIds)) return false;
      await tx.$executeRaw`UPDATE "artifacts" SET "access" = ${entry.from} WHERE "id" = ${entry.artifactId}::uuid`;
      await tx.artifactAccessEvent.create({
        data: { artifactId: entry.artifactId, from: "link", to: entry.from },
      });
      return true;
    }, TRANSACTION);
    if (!restored) skipped.push(entry.artifactId);
  }
  return skipped;
}

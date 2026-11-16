import type { PrismaClient } from "#src/generated/prisma/client";

type Db = Pick<PrismaClient, "artifactFile" | "artifactVersion" | "$queryRaw">;

export async function versionChanges(db: Db, artifactId: string, number: number) {
  if (number <= 1) return { changedPaths: [] as string[], renamed: null };
  const [files, versions] = await Promise.all([
    db.artifactFile.findMany({
      where: { artifactId, version: { number: { in: [number, number - 1] } } },
      select: { path: true, sha256: true, version: { select: { number: true } } },
    }),
    db.artifactVersion.findMany({
      where: { artifactId, number: { in: [number, number - 1] } },
      select: { number: true, title: true },
    }),
  ]);
  const shaAt = (at: number) =>
    new Map(files.filter((file) => file.version.number === at).map((f) => [f.path, f.sha256]));
  const now = shaAt(number);
  const before = shaAt(number - 1);
  const changedPaths = [...new Set([...now.keys(), ...before.keys()])]
    .filter((path) => now.get(path) !== before.get(path))
    .sort();
  const titleAt = (at: number) => versions.find((version) => version.number === at)?.title;
  const from = titleAt(number - 1);
  const to = titleAt(number);
  const renamed = from !== undefined && to !== undefined && from !== to ? { from, to } : null;
  return { changedPaths, renamed };
}

export async function lastChangers(
  db: Db,
  artifactId: string,
  upTo: number,
  paths: readonly string[],
): Promise<Map<string, string>> {
  if (paths.length === 0) return new Map();
  const rows = await db.$queryRaw<{ path: string; agentId: string | null }[]>`
    SELECT DISTINCT ON (f."path") f."path", v."publisherAgentId" AS "agentId"
    FROM "artifact_files" f
    JOIN "artifact_versions" v ON v."id" = f."versionId"
    WHERE f."artifactId" = ${artifactId}::uuid
      AND f."path" = ANY(${[...paths]}::text[])
      AND v."number" <= ${upTo}
      AND EXISTS (
        SELECT 1 FROM "artifact_files" held
        JOIN "artifact_versions" hv ON hv."id" = held."versionId"
        WHERE held."artifactId" = f."artifactId" AND held."path" = f."path" AND hv."number" = ${upTo}
      )
      AND NOT EXISTS (
        SELECT 1 FROM "artifact_files" earlier
        JOIN "artifact_versions" ev ON ev."id" = earlier."versionId"
        WHERE earlier."artifactId" = f."artifactId" AND earlier."path" = f."path"
          AND ev."number" = v."number" - 1 AND earlier."sha256" = f."sha256"
      )
    ORDER BY f."path", v."number" DESC`;
  return new Map(rows.flatMap((row) => (row.agentId ? [[row.path, row.agentId] as const] : [])));
}

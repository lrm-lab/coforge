import type { PrismaClient } from "#src/generated/prisma/client";
import { errorType } from "#src/server/errors/error-type.server";
import { actorNames, actorOf } from "./artifact-actor-names.server";

const UNSEEN_VERSIONS_SHOWN = 5;

const CHANGED_PATHS_SHOWN = 10;

type PositionDb = Pick<
  PrismaClient,
  "artifactReadPosition" | "artifactVersion" | "agent" | "user" | "$executeRaw"
>;

export type UnseenVersion = {
  number: number;
  publisher: { kind: "user" | "agent"; name: string };
  createdAt: Date;
  note: string;
  label: string;
  changedPaths: string[];
  changedCount: number;
};

export type UnseenSummary = {
  firstRead: boolean;
  versionCount: number;
  versions: UnseenVersion[];
};

export async function advanceReadPosition(
  db: Pick<PositionDb, "$executeRaw">,
  input: { artifactId: string; agentId: string; version: number },
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "artifact_read_positions" ("artifactId", "agentId", "version")
    VALUES (${input.artifactId}::uuid, ${input.agentId}::uuid, ${input.version})
    ON CONFLICT ("artifactId", "agentId") DO UPDATE
    SET "version" = EXCLUDED."version"
    WHERE "artifact_read_positions"."version" < EXCLUDED."version"`;
}

export async function noteReadPosition(
  db: Pick<PositionDb, "$executeRaw">,
  input: { artifactId: string; agentId: string; version: number },
): Promise<void> {
  try {
    await advanceReadPosition(db, input);
  } catch (error) {
    logPositionFailure(error);
  }
}

export async function countUnseenVersions(
  db: Pick<PositionDb, "artifactReadPosition" | "artifactVersion">,
  input: { artifactId: string; agentId: string; current: number },
): Promise<number> {
  const position = await db.artifactReadPosition.findUnique({
    where: { artifactId_agentId: { artifactId: input.artifactId, agentId: input.agentId } },
    select: { version: true },
  });
  return db.artifactVersion.count({
    where: {
      artifactId: input.artifactId,
      number: { gt: position?.version ?? 0, lte: input.current },
      OR: [{ publisherAgentId: null }, { publisherAgentId: { not: input.agentId } }],
    },
  });
}

function logPositionFailure(error: unknown) {
  console.warn(
    JSON.stringify({ event: "artifacts:read_position_failed", error_type: errorType(error) }),
  );
}

export async function readWithPosition(
  db: PositionDb,
  input: {
    artifactId: string;
    agentId: string;
    workspaceId: string;
    shown: number;
    current: number;
  },
): Promise<UnseenSummary | null> {
  const { artifactId, agentId, shown, current } = input;
  if (current <= 0 || shown !== current) return null;
  let summary: UnseenSummary;
  try {
    const position = await db.artifactReadPosition.findUnique({
      where: { artifactId_agentId: { artifactId, agentId } },
      select: { version: true },
    });
    const unseen = await unseenVersions(db, { ...input, after: position?.version ?? 0 });
    summary = { firstRead: position === null, ...unseen };
  } catch (error) {
    logPositionFailure(error);
    return null;
  }
  await noteReadPosition(db, { artifactId, agentId, version: current });
  return summary;
}

export async function unseenVersions(
  db: Pick<PositionDb, "artifactVersion" | "agent" | "user">,
  input: {
    artifactId: string;
    agentId: string;
    workspaceId: string;
    after: number;
    current: number;
  },
) {
  const where = {
    artifactId: input.artifactId,
    number: { gt: input.after, lte: input.current },
    OR: [{ publisherAgentId: null }, { publisherAgentId: { not: input.agentId } }],
  };
  const [versionCount, rows] = await Promise.all([
    db.artifactVersion.count({ where }),
    db.artifactVersion.findMany({
      where,
      orderBy: { number: "desc" },
      take: UNSEEN_VERSIONS_SHOWN,
      select: {
        number: true,
        publisherAgentId: true,
        note: true,
        label: true,
        changedPaths: true,
        createdAt: true,
      },
    }),
  ]);
  const names = await actorNames(db, input.workspaceId, {
    userIds: [],
    agentIds: rows.flatMap((row) => row.publisherAgentId ?? []),
  });
  const versions = rows.map(({ publisherAgentId, changedPaths, ...version }): UnseenVersion => {
    const paths = changedPathsOf(changedPaths);
    return {
      ...version,
      changedPaths: paths.slice(0, CHANGED_PATHS_SHOWN),
      changedCount: paths.length,
      publisher: actorOf(names, { userId: null, agentId: publisherAgentId }),
    };
  });
  return { versionCount, versions };
}

export function changedPathsOf(changed: unknown): string[] {
  if (!changed || typeof changed !== "object") return [];
  const { added, deleted } = changed as { added?: unknown; deleted?: unknown };
  return [added, deleted].flatMap((paths) =>
    Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : [],
  );
}

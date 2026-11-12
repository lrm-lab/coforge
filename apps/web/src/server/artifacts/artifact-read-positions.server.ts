import type { PrismaClient } from "#src/generated/prisma/client";
import { errorType } from "#src/server/errors/error-type.server";
import { actorNames, actorOf } from "./artifact-actor-names.server";

/** How many unseen versions a read lists (the newest); the count is of all of them. */
const UNSEEN_VERSIONS_SHOWN = 5;

/** How many changed paths a listed version names; `changedCount` is of all of them. */
const CHANGED_PATHS_SHOWN = 10;

type PositionDb = Pick<
  PrismaClient,
  "artifactReadPosition" | "artifactVersion" | "agent" | "user" | "$executeRaw"
>;

/** A version someone else published since the Agent's position, as a read shows it. */
export type UnseenVersion = {
  number: number;
  publisher: { kind: "user" | "agent"; name: string };
  createdAt: Date;
  note: string;
  label: string;
  changedPaths: string[];
  changedCount: number;
};

/** What others published since an Agent last looked, as the answer to a read of the current
 * version. `firstRead` is true when the Agent had no position. */
export type UnseenSummary = {
  firstRead: boolean;
  versionCount: number;
  versions: UnseenVersion[];
};

/**
 * Moves an Agent's position on an artifact to `version`, never backwards: a stored value that is
 * already as far is left alone (a re-read writes nothing), and reads that race each other cannot
 * rewind it.
 *
 * An Agent's own revert does not move its position: a revert is a version it published, which
 * its unseen list leaves out anyway, so only the versions of others after it count.
 */
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

/**
 * The position after a save or read that already committed: a failure is logged, never the
 * caller's, so a stored write or a read does not turn into an error over bookkeeping.
 */
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

/** How many versions others published after the Agent's version position, up to the current one:
 * what `comments` says beside the comments, so the Agent knows to read the artifact again. */
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

/**
 * What an Agent reads when it reads the artifact's current version: the versions others
 * published after its position up to the version shown (all of them on a first read), computed
 * before the position moves to that version. Reading an older version answers `null` and moves
 * nothing. The position is bookkeeping: if it cannot be read, the answer is `null`; if it cannot
 * be written, the answer is still what was computed.
 */
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

async function unseenVersions(
  db: PositionDb,
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
    // Up to the version the read shows: one published since the load is for the next read.
    number: { gt: input.after, lte: input.current },
    // A version with no publisher (a removed account) is someone else's.
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
        publisherUserId: true,
        publisherAgentId: true,
        note: true,
        label: true,
        changedPaths: true,
        createdAt: true,
      },
    }),
  ]);
  const names = await actorNames(db, input.workspaceId, {
    userIds: rows.flatMap((row) => row.publisherUserId ?? []),
    agentIds: rows.flatMap((row) => row.publisherAgentId ?? []),
  });
  const versions = rows.map(
    ({ publisherUserId, publisherAgentId, changedPaths, ...version }): UnseenVersion => {
      const paths = pathsOf(changedPaths);
      return {
        ...version,
        changedPaths: paths.slice(0, CHANGED_PATHS_SHOWN),
        changedCount: paths.length,
        publisher: actorOf(names, { userId: publisherUserId, agentId: publisherAgentId }),
      };
    },
  );
  return { versionCount, versions };
}

/** What a version changed (`{ added, deleted }` as a save stores it), as one list of paths:
 * files added or replaced, then files removed. */
function pathsOf(changed: unknown): string[] {
  if (!changed || typeof changed !== "object") return [];
  const { added, deleted } = changed as { added?: unknown; deleted?: unknown };
  return [added, deleted].flatMap((paths) =>
    Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : [],
  );
}

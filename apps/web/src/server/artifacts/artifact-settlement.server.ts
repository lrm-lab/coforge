import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { errorType } from "#src/server/errors/error-type.server";
import { artifactTier, requireArtifactRead, type ArtifactActor } from "./artifact-access.server";
import { actorNames, actorOf } from "./artifact-actor-names.server";
import { followByWriting, startFollowing } from "./artifact-follows.server";
import { announceSettlementChange, type ArtifactSignals } from "./artifact-signals.server";

export type ArtifactSettlementActor = { kind: "user" | "agent"; name: string };

export type ArtifactSettledView = {
  at: string;
  version: number;
  by: ArtifactSettlementActor;
};

export type ArtifactReopenedView = {
  version: number;
  was: ArtifactSettledView;
};

export type ArtifactSettlementView = {
  settled: ArtifactSettledView | null;
  reopened: ArtifactReopenedView | null;
};

export type ArtifactSettlementRow = {
  settledAt: Date | null;
  settledVersion: number | null;
  settledByKind: string | null;
  settledById: string | null;
  reopenedAtVersion: number | null;
};

export const SETTLEMENT_SELECT = {
  settledAt: true,
  settledVersion: true,
  settledByKind: true,
  settledById: true,
  reopenedAtVersion: true,
} as const;

export const EMPTY_SETTLEMENT: ArtifactSettlementView = { settled: null, reopened: null };

function settlementActorIds(rows: readonly ArtifactSettlementRow[]) {
  const userIds: string[] = [];
  const agentIds: string[] = [];
  for (const row of rows) {
    if (!row.settledAt || !row.settledById) continue;
    if (row.settledByKind === "user") userIds.push(row.settledById);
    else if (row.settledByKind === "agent") agentIds.push(row.settledById);
  }
  return { userIds, agentIds };
}

function buildSettlementView(
  row: ArtifactSettlementRow,
  names: ReadonlyMap<string, string>,
): ArtifactSettlementView {
  if (!row.settledAt || row.settledVersion === null) return EMPTY_SETTLEMENT;
  const by = actorOf(names, {
    userId: row.settledByKind === "user" ? row.settledById : null,
    agentId: row.settledByKind === "agent" ? row.settledById : null,
  });
  const record: ArtifactSettledView = {
    at: row.settledAt.toISOString(),
    version: row.settledVersion,
    by,
  };
  if (row.reopenedAtVersion !== null) {
    return { settled: null, reopened: { version: row.reopenedAtVersion, was: record } };
  }
  return { settled: record, reopened: null };
}

export async function resolveSettlementViews<T extends ArtifactSettlementRow>(
  db: Pick<PrismaClient, "user" | "agent">,
  workspaceId: string,
  rows: readonly T[],
): Promise<ArtifactSettlementView[]> {
  if (!rows.some((row) => row.settledAt !== null)) {
    return rows.map(() => EMPTY_SETTLEMENT);
  }
  const names = await actorNames(db, workspaceId, settlementActorIds(rows));
  return rows.map((row) => buildSettlementView(row, names));
}

export class SettledArtifactHold extends AppError {
  readonly settledAt: Date;

  constructor(input: {
    title: string;
    settledAt: Date;
    settledVersion: number;
    settledByName: string;
    nextVersion: number;
  }) {
    const day = input.settledAt.toISOString().slice(0, 10);
    super("CONFLICT", {
      errorId: "artifact-settled",
      details: {
        title: input.title,
        settledBy: input.settledByName,
        settledAt: input.settledAt.toISOString(),
        settledVersion: input.settledVersion,
        nextVersion: input.nextVersion,
      },
      hint: `Held — not pushed. "${input.title}" was settled by @${input.settledByName} on ${day} at v${input.settledVersion}. Pushing makes v${input.nextVersion} and takes it back to Working. If that's intended, run the same command again: it goes through now.`,
    });
    this.settledAt = input.settledAt;
  }
}

export async function requireNotSettledOrSeen(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    artifactId: string;
    agentId: string;
    current: number;
    title: string;
    settlement: ArtifactSettlementRow;
  },
): Promise<void> {
  const { settlement } = input;
  if (!settlement.settledAt || settlement.reopenedAtVersion !== null) return;
  const position = await tx.artifactReadPosition.findUnique({
    where: { artifactId_agentId: { artifactId: input.artifactId, agentId: input.agentId } },
    select: { seenSettledAt: true },
  });
  if (position?.seenSettledAt?.getTime() === settlement.settledAt.getTime()) return;
  const [view] = await resolveSettlementViews(tx, input.workspaceId, [settlement]);
  throw new SettledArtifactHold({
    title: input.title,
    settledAt: settlement.settledAt,
    settledVersion: settlement.settledVersion ?? input.current,
    settledByName: view?.settled?.by.name ?? "someone",
    nextVersion: input.current + 1,
  });
}

type SettlementOutcome = {
  artifact: {
    id: string;
    name: string;
    title: string;
    currentVersion: number;
    settled: ArtifactSettledView | null;
    reopened: ArtifactReopenedView | null;
  };
  changed: boolean;
  newlyFollowing?: true;
};

export class ArtifactSettlements {
  constructor(
    private readonly db: PrismaClient,
    private readonly signals?: ArtifactSignals,
  ) {}

  async settle(input: {
    workspaceId: string;
    artifactId: string;
    actor: ArtifactActor;
  }): Promise<SettlementOutcome> {
    return this.transition(input, true);
  }

  async unsettle(input: {
    workspaceId: string;
    artifactId: string;
    actor: ArtifactActor;
  }): Promise<SettlementOutcome> {
    return this.transition(input, false);
  }

  private async transition(
    input: { workspaceId: string; artifactId: string; actor: ArtifactActor },
    settling: boolean,
  ): Promise<SettlementOutcome> {
    const live = await this.db.artifact.findFirst({
      where: { id: input.artifactId, workspaceId: input.workspaceId, deletedAt: null },
      select: { id: true, homeKey: true, access: true, authorAgentId: true },
    });
    if (!live) throw new AppError("NOT_FOUND");
    await requireArtifactRead(this.db, input.workspaceId, input.actor, live);

    const isUser = input.actor.userId !== undefined;
    const actorKind: "user" | "agent" = isUser ? "user" : "agent";
    const actorId = isUser ? input.actor.userId! : input.actor.agentId!;

    const result = await this.db.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<
        ({
          id: string;
          name: string;
          title: string;
          currentVersion: number;
        } & ArtifactSettlementRow)[]
      >`SELECT "id", "name", "title", "currentVersion", "settledAt", "settledVersion",
               "settledByKind", "settledById", "reopenedAtVersion"
        FROM "artifacts"
        WHERE "id" = ${input.artifactId}::uuid AND "workspaceId" = ${input.workspaceId}::uuid
          AND "deletedAt" IS NULL
        FOR UPDATE`;
      if (!locked) throw new AppError("NOT_FOUND");
      const currentlySettled = locked.settledAt !== null && locked.reopenedAtVersion === null;
      if (settling) {
        if (currentlySettled) return { row: locked, changed: false };
        const rawNow = new Date();
        const now =
          locked.settledAt && rawNow.getTime() <= locked.settledAt.getTime()
            ? new Date(locked.settledAt.getTime() + 1)
            : rawNow;
        await tx.artifact.update({
          where: { id: locked.id },
          data: {
            settledAt: now,
            settledVersion: locked.currentVersion,
            settledByKind: actorKind,
            settledById: actorId,
            reopenedAtVersion: null,
          },
        });
        return {
          row: {
            ...locked,
            settledAt: now,
            settledVersion: locked.currentVersion,
            settledByKind: actorKind,
            settledById: actorId,
            reopenedAtVersion: null,
          },
          changed: true,
        };
      }
      if (!currentlySettled) return { row: locked, changed: false };
      await tx.artifact.update({
        where: { id: locked.id },
        data: {
          settledAt: null,
          settledVersion: null,
          settledByKind: null,
          settledById: null,
          reopenedAtVersion: null,
        },
      });
      return {
        row: {
          ...locked,
          settledAt: null,
          settledVersion: null,
          settledByKind: null,
          settledById: null,
          reopenedAtVersion: null,
        },
        changed: true,
      };
    });

    const [[view], followed] = await Promise.all([
      resolveSettlementViews(this.db, input.workspaceId, [result.row]),
      settling && result.changed
        ? input.actor.agentId !== undefined
          ? followByWriting(this.db, {
              artifactId: result.row.id,
              agentId: input.actor.agentId,
            }).catch((error) => {
              console.warn(
                JSON.stringify({ event: "artifacts:follow_failed", error_type: errorType(error) }),
              );
              return { newlyFollowing: false };
            })
          : input.actor.userId !== undefined
            ? startFollowing(this.db, result.row.id, [{ userId: input.actor.userId }])
                .then(() => ({ newlyFollowing: false }))
                .catch((error) => {
                  console.warn(
                    JSON.stringify({
                      event: "artifacts:follow_failed",
                      error_type: errorType(error),
                    }),
                  );
                  return { newlyFollowing: false };
                })
            : Promise.resolve({ newlyFollowing: false })
        : Promise.resolve({ newlyFollowing: false }),
      result.changed
        ? announceSettlementChange(this.signals, {
            workspaceId: input.workspaceId,
            homeKey: live.homeKey,
            wide: artifactTier(live) === "workspace",
            artifactId: result.row.id,
          })
        : Promise.resolve(),
    ]);

    return {
      artifact: {
        id: result.row.id,
        name: result.row.name,
        title: result.row.title,
        currentVersion: result.row.currentVersion,
        settled: view?.settled ?? null,
        reopened: view?.reopened ?? null,
      },
      changed: result.changed,
      ...(followed.newlyFollowing ? { newlyFollowing: true as const } : {}),
    };
  }
}

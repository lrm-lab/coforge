import {
  TeamMemoryReads,
  readTarget,
  projectEvidence,
} from "./team-memory-read.repositories.server";
import {
  beginTeamMemoryMaintenance,
  suggestTeamMemoryMaintenance,
  consumeTeamMemoryMaintenance,
  replayTeamMemoryMaintenanceHint,
} from "./team-memory-maintenance.repositories.server";
import { teamMemoryCatalog } from "./team-memory-projects.repositories.server";
import { memoryReceipts } from "./team-memory-receipts.repositories.server";
import { teamMemoryAccess as access } from "./team-memory-access.repositories.server";
import { readableMemoryEvidence } from "./team-memory-evidence.server";
import { head, searchText, fingerprint, type Row } from "./team-memory-projections.server";
import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import {
  type TeamMemoryCatalogCommand,
  type TeamMemoryDraft,
  type TeamMemoryHead,
  type TeamMemoryResult,
  type TeamMemoryWrite,
} from "@lrm/coforge-sdk/agent";
import {
  TeamMemoryError,
  teamMemoryDedup,
  validateTeamMutation,
  type TeamMemoryActor,
  type TeamMemoryStore,
} from "#src/server/team-memory/memory";

export class PrismaTeamMemoryStore implements TeamMemoryStore {
  private readonly reads: TeamMemoryReads;

  constructor(private readonly db: PrismaClient) {
    this.reads = new TeamMemoryReads(db);
  }

  beginMaintenance(actor: TeamMemoryActor): Promise<TeamMemoryResult> {
    return beginTeamMemoryMaintenance(this.db, actor);
  }

  catalog(actor: TeamMemoryActor, command: TeamMemoryCatalogCommand): Promise<TeamMemoryResult> {
    return teamMemoryCatalog(this.db, actor, command);
  }

  read(
    actor: TeamMemoryActor,
    command: Parameters<TeamMemoryReads["read"]>[1],
  ): Promise<TeamMemoryResult> {
    return this.reads.read(actor, command);
  }

  async review(actor: TeamMemoryActor, command: TeamMemoryWrite): Promise<TeamMemoryResult> {
    const hash = fingerprint(command);
    return this.db.$transaction(
      async (tx) => {
        await access(tx, actor);
        const receipts = memoryReceipts(tx, actor, command.requestId);
        const existing = await receipts.get();
        if (existing && existing.fingerprint !== hash) throw new TeamMemoryError("conflict");
        if (existing?.entryId)
          return this.replay(tx, actor, command, existing.entryId, existing.deleted);
        const query =
          "title" in command
            ? `${command.title} ${command.content} ${command.applicability}`
            : head(await readTarget(tx, actor, command.id)).title;
        const related = await this.reads.prepare(tx, actor, query);
        const reviewToken = crypto.randomUUID();
        const data = {
          reviewToken,
          reviewRevision: related.reviewRevision!,
          reviewExpiresAt: new Date(Date.now() + 10 * 60_000),
        };
        await receipts.prune();
        await receipts.review(hash, data);
        return { ...related, status: "review_required", reviewToken };
      },
      { isolationLevel: "RepeatableRead" },
    );
  }

  private async replay(
    tx: Prisma.TransactionClient,
    actor: TeamMemoryActor,
    command: TeamMemoryWrite,
    entryId: string,
    deleted: boolean,
  ): Promise<TeamMemoryResult> {
    if (deleted) return { status: "deleted", entries: [], replayed: true };
    const [entry, maintenanceHint] = await Promise.all([
      readTarget(tx, actor, entryId),
      replayTeamMemoryMaintenanceHint(tx, actor, command),
    ]);
    return {
      status: "ok",
      entries: [await projectEvidence(tx, actor.workspaceId, head(entry))],
      replayed: true,
      ...(maintenanceHint ? { maintenanceHint } : {}),
    };
  }

  async write(actor: TeamMemoryActor, command: TeamMemoryWrite): Promise<TeamMemoryResult> {
    const hash = fingerprint(command);
    try {
      return await this.db.$transaction(
        async (tx) => {
          const admin = await access(tx, actor, true);
          await tx.teamMemoryState.upsert({
            where: { workspaceId: actor.workspaceId },
            create: { workspaceId: actor.workspaceId },
            update: {},
          });
          const [state] = await tx.$queryRaw<
            { revision: number }[]
          >`SELECT revision FROM team_memory_states WHERE workspace_id = ${actor.workspaceId}::uuid FOR UPDATE`;
          const receipts = memoryReceipts(tx, actor, command.requestId);
          const receipt = await receipts.get();
          if (receipt && receipt.fingerprint !== hash) throw new TeamMemoryError("conflict");
          if (receipt?.entryId)
            return this.replay(tx, actor, command, receipt.entryId, receipt.deleted);
          if (
            !receipt ||
            receipt.reviewToken !== command.reviewToken ||
            !receipt.reviewExpiresAt ||
            receipt.reviewExpiresAt.getTime() <= Date.now() ||
            state?.revision !== receipt.reviewRevision
          )
            throw new TeamMemoryError("conflict");
          let target =
            command.operation === "create"
              ? ((await tx.teamMemoryEntry.findUnique({
                  where: {
                    workspaceId_dedupKey: {
                      workspaceId: actor.workspaceId,
                      dedupKey: teamMemoryDedup(command),
                    },
                  },
                })) as Row | null)
              : await readTarget(tx, actor, command.id);
          if (
            actor.agentId &&
            actor.includeHumanAuthors === false &&
            target &&
            !target.authorAgentId
          )
            throw new TeamMemoryError("upgrade_required");
          const sources =
            command.operation === "merge"
              ? ((await tx.teamMemoryEntry.findMany({
                  where: {
                    workspaceId: actor.workspaceId,
                    id: { in: command.sources.map((source) => source.id) },
                    status: { not: "deleted" },
                  },
                  take: 10,
                })) as Row[])
              : [];
          if (command.maintenanceToken)
            await consumeTeamMemoryMaintenance(tx, actor, command, target, sources);
          if (target && command.operation === "create") {
            if (command.projectId !== undefined && command.projectId !== (target.projectId ?? null))
              throw new TeamMemoryError("conflict");
            await receipts.update({ entryId: target.id, reviewToken: null, reviewExpiresAt: null });
            return {
              status: "ok",
              entries: [await projectEvidence(tx, actor.workspaceId, head(target))],
            };
          }
          validateTeamMutation(
            actor,
            command,
            target ? head(target) : undefined,
            sources.map(head),
            admin ||
              !!(
                actor.userId &&
                target?.authorAgentId &&
                (await tx.agent.findFirst({
                  where: {
                    id: target.authorAgentId,
                    workspaceId: actor.workspaceId,
                    ownerId: actor.userId,
                    deletedAt: null,
                  },
                  select: { id: true },
                }))
              ),
          );
          if (command.operation === "delete") {
            await tx.teamMemoryEntry.update({
              where: { id: target!.id },
              data: {
                status: "deleted",
                dedupKey: `deleted:${target!.id}`,
                title: "",
                content: "",
                source: "",
                evidence: Prisma.DbNull,
                relations: Prisma.DbNull,
                effectiveAt: null,
                applicability: "",
                searchText: "",
                revision: { increment: 1 },
              },
            });
            await tx.teamMemoryVersion.deleteMany({
              where: { workspaceId: actor.workspaceId, entryId: target!.id },
            });
            await receipts.update({
              entryId: target!.id,
              deleted: true,
              reviewToken: null,
              reviewExpiresAt: null,
            });
            await tx.teamMemoryState.update({
              where: { workspaceId: actor.workspaceId },
              data: { revision: { increment: 1 } },
            });
            return { status: "deleted", entries: [] };
          }
          let draft: TeamMemoryDraft;
          if (command.operation === "restore") {
            const version = await tx.teamMemoryVersion.findUnique({
              where: {
                workspaceId_entryId_revision: {
                  workspaceId: actor.workspaceId,
                  entryId: command.id,
                  revision: command.fromRevision,
                },
              },
            });
            if (!version) throw new TeamMemoryError("not_found");
            draft = version.snapshot as unknown as TeamMemoryHead;
          } else draft = "title" in command ? command : head(target!);
          let projectId =
            draft.projectId === undefined ? (target?.projectId ?? null) : draft.projectId;
          if (projectId) {
            const projects = await tx.$queryRaw<
              { id: string }[]
            >`SELECT id FROM projects WHERE id = ${projectId}::uuid AND "workspaceId" = ${actor.workspaceId}::uuid FOR SHARE`;
            if (!projects.length) {
              if (command.operation === "restore") projectId = null;
              else throw new TeamMemoryError("forbidden");
            }
          }
          const status =
            command.operation === "archive" ||
            (command.operation === "update" && target?.status === "archived")
              ? "archived"
              : "active";
          const previous = target ? head(target) : undefined;
          const restore = command.operation === "restore";
          const evidence = draft.evidence ?? (restore ? undefined : previous?.evidence);
          const relations = draft.relations ?? (restore ? undefined : previous?.relations);
          const effectiveAt =
            draft.effectiveAt === undefined
              ? restore
                ? undefined
                : previous?.effectiveAt
              : draft.effectiveAt;
          if (
            "title" in command &&
            command.evidence?.length &&
            (await readableMemoryEvidence(tx, actor.workspaceId, command.evidence)).length !==
              command.evidence.length
          )
            throw new TeamMemoryError("forbidden");
          if ("title" in command && command.relations?.length) {
            const related = await tx.teamMemoryEntry.findMany({
              where: {
                workspaceId: actor.workspaceId,
                id: { in: command.relations.map(({ id }) => id) },
                status: "active",
              },
              select: { id: true, revision: true, projectId: true, applicability: true },
              take: command.relations.length,
            });
            if (
              command.relations.some(
                (link) =>
                  !related.some(
                    (row) =>
                      row.id === link.id &&
                      row.id !== target?.id &&
                      row.revision === link.revision &&
                      (link.kind === "conflicts_with" ||
                        (row.projectId === projectId && row.applicability === draft.applicability)),
                  ),
              )
            )
              throw new TeamMemoryError("conflict");
          }
          const data = {
            projectId,
            pinned: draft.pinned ?? target?.pinned ?? false,
            title: draft.title,
            content: draft.content,
            source: draft.source,
            evidence: evidence ?? Prisma.DbNull,
            relations: relations ?? Prisma.DbNull,
            effectiveAt: effectiveAt ? new Date(effectiveAt) : null,
            kind: draft.kind,
            applicability: draft.applicability,
            dedupKey:
              status === "archived"
                ? `archived:${target!.id}`
                : teamMemoryDedup({ ...draft, projectId }),
            searchText: searchText(draft),
            status,
          };
          const archivedAt = new Date();
          if (sources.length)
            await tx.$executeRaw`UPDATE team_memory_entries SET status = 'archived', dedup_key = 'archived:' || id::text, revision = revision + 1, updated_at = ${archivedAt} WHERE workspace_id = ${actor.workspaceId}::uuid AND id = ANY(${sources.map((source) => source.id)}::uuid[])`;
          target = target
            ? ((await tx.teamMemoryEntry.update({
                where: { id: target.id },
                data: { ...data, revision: { increment: 1 } },
              })) as Row)
            : ((await tx.teamMemoryEntry.create({
                data: {
                  ...data,
                  workspaceId: actor.workspaceId,
                  authorAgentId: actor.agentId ?? null,
                  authorUserId: actor.userId ?? null,
                },
              })) as Row);
          const saved = head(target);
          await tx.teamMemoryVersion.create({
            data: {
              workspaceId: actor.workspaceId,
              entryId: target.id,
              revision: saved.revision,
              snapshot: { ...saved },
              actorAgentId: actor.agentId ?? null,
              actorUserId: actor.userId ?? null,
              operation: command.operation,
              reason: "reason" in command ? command.reason : "Confirmed shared knowledge",
              mergedFrom: command.operation === "merge" ? command.sources : [],
            },
          });
          if (sources.length) {
            await tx.teamMemoryVersion.createMany({
              data: sources.map((source) => ({
                workspaceId: actor.workspaceId,
                entryId: source.id,
                revision: source.revision + 1,
                snapshot: {
                  ...head(source),
                  updatedAt: archivedAt.toISOString(),
                  revision: source.revision + 1,
                  status: "archived",
                },
                actorAgentId: actor.agentId ?? null,
                actorUserId: actor.userId ?? null,
                operation: "merge-source",
                reason: `Merged into ${saved.id}`,
                mergedFrom: [],
              })),
            });
          }
          await receipts.update({ entryId: target.id, reviewToken: null, reviewExpiresAt: null });
          await tx.teamMemoryState.update({
            where: { workspaceId: actor.workspaceId },
            data: { revision: { increment: 1 } },
          });
          const maintenanceHint =
            !command.maintenanceToken && actor.agentId
              ? await suggestTeamMemoryMaintenance(tx, actor, saved, command.requestId)
              : undefined;
          return {
            status: "ok",
            entries: [
              "title" in command && command.evidence !== undefined
                ? saved
                : await projectEvidence(tx, actor.workspaceId, saved),
            ],
            ...(maintenanceHint ? { maintenanceHint } : {}),
          };
        },
        { timeout: 10_000 },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ["P2002", "P2034"].includes(error.code)
      )
        throw new TeamMemoryError("conflict");
      throw error;
    }
  }
}

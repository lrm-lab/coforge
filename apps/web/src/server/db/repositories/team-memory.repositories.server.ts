import {
  beginTeamMemoryMaintenance,
  suggestTeamMemoryMaintenance,
  consumeTeamMemoryMaintenance,
  replayTeamMemoryMaintenanceHint,
} from "./team-memory-maintenance.repositories.server";
import { teamMemoryCatalog } from "./team-memory-projects.repositories.server";
import { memoryReceipts } from "./team-memory-receipts.repositories.server";
import { teamMemoryAccess as access } from "./team-memory-access.repositories.server";
import {
  head,
  versionHead,
  searchText,
  escapeLike,
  fingerprint,
  PREVIEW_WHITESPACE,
  type Row,
  type Version,
} from "./team-memory-projections.server";
import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import {
  teamMemoryTerms,
  type TeamMemoryCommand,
  type TeamMemoryMaintenanceCommand,
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

type Database = PrismaClient | Prisma.TransactionClient;
async function readTarget(db: Database, actor: TeamMemoryActor, id: string): Promise<Row> {
  const row = await db.teamMemoryEntry.findFirst({
    where: { workspaceId: actor.workspaceId, id, status: { not: "deleted" } },
  });
  if (!row) throw new TeamMemoryError("not_found");
  if (actor.agentId && actor.includeHumanAuthors === false && !row.authorAgentId)
    throw new TeamMemoryError("upgrade_required");
  return row as Row;
}

async function search(
  db: Database,
  workspaceId: string,
  query: string,
  offset = 0,
  projectId?: string,
  archived = false,
  includeHumanAuthors = true,
): Promise<Row[]> {
  const terms = teamMemoryTerms(query);
  if (!terms.length) return [];
  const matches = terms.map((term) => Prisma.sql`search_text ILIKE ${`%${escapeLike(term)}%`}`);
  const ranks = terms.map(
    (term) =>
      Prisma.sql`CASE WHEN search_text ILIKE ${`%${escapeLike(term)}%`} THEN ${term.length > 2 ? 3 : 1} ELSE 0 END`,
  );
  return db.$queryRaw<Row[]>(Prisma.sql`
    SELECT id, workspace_id AS "workspaceId", title, left(ltrim(content, ${PREVIEW_WHITESPACE}), 600) AS content, left(ltrim(source, ${PREVIEW_WHITESPACE}), 200) AS source, kind, applicability, status,
      revision, author_agent_id AS "authorAgentId", author_user_id AS "authorUserId", project_id AS "projectId", pinned, updated_at AS "updatedAt"
    FROM team_memory_entries WHERE workspace_id = ${workspaceId}::uuid AND status = ${archived ? "archived" : "active"}
    AND (${Prisma.join(matches, " OR ")})
    ${includeHumanAuthors ? Prisma.empty : Prisma.sql`AND author_agent_id IS NOT NULL`}
    ${projectId ? Prisma.sql`AND project_id = ${projectId}::uuid` : Prisma.empty}
    ORDER BY (${Prisma.join(ranks, " + ")}) DESC, updated_at DESC, id ASC LIMIT 11 OFFSET ${offset}`);
}

function page(rows: Row[], offset: number, snippets = false): TeamMemoryResult {
  const entries = rows.slice(0, 10).map((row) => {
    const entry = head(row);
    return snippets
      ? { ...entry, content: entry.content.slice(0, 600), source: entry.source.slice(0, 200) }
      : entry;
  });
  return { status: "ok", entries, ...(rows.length > 10 ? { nextOffset: offset + 10 } : {}) };
}

export class PrismaTeamMemoryStore implements TeamMemoryStore {
  constructor(private readonly db: PrismaClient) {}

  beginMaintenance(actor: TeamMemoryActor): Promise<TeamMemoryResult> {
    return beginTeamMemoryMaintenance(this.db, actor);
  }

  catalog(actor: TeamMemoryActor, command: TeamMemoryCatalogCommand): Promise<TeamMemoryResult> {
    return teamMemoryCatalog(this.db, actor, command);
  }

  async read(
    actor: TeamMemoryActor,
    command: Exclude<
      TeamMemoryCommand,
      TeamMemoryWrite | TeamMemoryCatalogCommand | TeamMemoryMaintenanceCommand
    >,
  ): Promise<TeamMemoryResult> {
    return this.db.$transaction(
      async (tx) => {
        await access(tx, actor);
        if (command.operation === "prepare")
          return this.prepare(
            tx,
            actor,
            `${command.title} ${command.content} ${command.applicability}`,
          );
        if (command.operation === "search")
          return page(
            await search(
              tx,
              actor.workspaceId,
              command.query,
              command.offset,
              command.projectId,
              command.archived,
              !(actor.agentId && actor.includeHumanAuthors === false),
            ),
            command.offset ?? 0,
            true,
          );
        if (command.operation === "list")
          return page(
            await tx.$queryRaw<Row[]>(
              Prisma.sql`SELECT id, workspace_id AS "workspaceId", title, left(ltrim(content, ${PREVIEW_WHITESPACE}),600) AS content, left(ltrim(source, ${PREVIEW_WHITESPACE}),200) AS source, kind, applicability, status, revision, author_agent_id AS "authorAgentId", author_user_id AS "authorUserId", project_id AS "projectId", pinned, updated_at AS "updatedAt" FROM team_memory_entries WHERE workspace_id = ${actor.workspaceId}::uuid AND status = ${command.archived ? "archived" : "active"} ${actor.agentId && actor.includeHumanAuthors === false ? Prisma.sql`AND author_agent_id IS NOT NULL` : Prisma.empty} ${command.projectId ? Prisma.sql`AND project_id = ${command.projectId}::uuid` : Prisma.empty} ORDER BY updated_at DESC, id ASC LIMIT 11 OFFSET ${command.offset ?? 0}`,
            ),
            command.offset ?? 0,
            true,
          );
        const target = await readTarget(tx, actor, command.id);
        if (command.operation === "get") {
          if (command.revision === undefined) return { status: "ok", entries: [head(target)] };
          const version = await tx.teamMemoryVersion.findUnique({
            where: {
              workspaceId_entryId_revision: {
                workspaceId: actor.workspaceId,
                entryId: target.id,
                revision: command.revision,
              },
            },
          });
          if (!version) throw new TeamMemoryError("not_found");
          return { status: "ok", entries: [versionHead(version)] };
        }
        const offset = command.offset ?? 0;
        const versions = await tx.$queryRaw<Version[]>`
          SELECT snapshot || jsonb_build_object(
            'content', left(ltrim(snapshot->>'content', ${PREVIEW_WHITESPACE}), 600),
            'source', left(ltrim(snapshot->>'source', ${PREVIEW_WHITESPACE}), 200)
          ) AS snapshot, actor_agent_id AS "actorAgentId", actor_user_id AS "actorUserId", operation, left(reason, 200) AS reason, merged_from AS "mergedFrom"
          FROM team_memory_versions
          WHERE workspace_id = ${actor.workspaceId}::uuid AND entry_id = ${target.id}::uuid
          ORDER BY revision DESC LIMIT 11 OFFSET ${offset}`;
        const result: TeamMemoryResult = { status: "ok", entries: [] };
        for (const version of versions.slice(0, 10)) {
          const entry = versionHead(version);
          const candidate = {
            ...result,
            entries: [...result.entries, entry],
            nextOffset: offset + result.entries.length + 1,
          };
          if (Buffer.byteLength(JSON.stringify(candidate)) > 12_000) break;
          result.entries.push(entry);
        }
        if (versions.length > result.entries.length)
          result.nextOffset = offset + result.entries.length;
        return result;
      },
      { isolationLevel: "RepeatableRead" },
    );
  }

  private async prepare(
    db: Database,
    actor: TeamMemoryActor,
    query: string,
  ): Promise<TeamMemoryResult> {
    const [state, rows] = await Promise.all([
      db.teamMemoryState.findUnique({ where: { workspaceId: actor.workspaceId } }),
      search(
        db,
        actor.workspaceId,
        query,
        0,
        undefined,
        false,
        !(actor.agentId && actor.includeHumanAuthors === false),
      ),
    ]);
    const related = page(rows, 0, true);
    return { ...related, status: "ok", reviewRevision: state?.revision ?? 0 };
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
        const related = await this.prepare(tx, actor, query);
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
      entries: [head(entry)],
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
            return { status: "ok", entries: [head(target)] };
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
          } else draft = "title" in command ? command : target!;
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
          const data = {
            projectId,
            pinned: draft.pinned ?? target?.pinned ?? false,
            title: draft.title,
            content: draft.content,
            source: draft.source,
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
            entries: [saved],
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

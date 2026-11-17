import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { EXPERIMENTS } from "#src/server/experiments/experiments.server";
import {
  teamMemoryTerms,
  type TeamMemoryCommand,
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
const PREVIEW_WHITESPACE =
  " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
type Row = TeamMemoryDraft & {
  id: string;
  workspaceId: string;
  revision: number;
  status: string;
  authorAgentId: string;
  updatedAt: Date;
};
type Version = {
  snapshot: Prisma.JsonValue;
  actorAgentId: string;
  operation: string;
  reason: string;
  mergedFrom: Prisma.JsonValue;
};

function versionHead(version: Version): TeamMemoryHead {
  return {
    ...(version.snapshot as unknown as TeamMemoryHead),
    change: {
      actorAgentId: version.actorAgentId,
      operation: version.operation,
      reason: version.reason,
      mergedFrom: version.mergedFrom as { id: string; revision: number }[],
    },
  };
}

function head(row: Row): TeamMemoryHead {
  if (row.status !== "active" && row.status !== "archived") throw new TeamMemoryError("not_found");
  return {
    id: row.id,
    revision: row.revision,
    status: row.status,
    authorAgentId: row.authorAgentId,
    updatedAt: row.updatedAt.toISOString(),
    title: row.title,
    content: row.content,
    source: row.source,
    applicability: row.applicability,
    kind: row.kind,
  };
}
function searchText(draft: TeamMemoryDraft): string {
  return `${draft.title}\n${draft.content}\n${draft.applicability}`.normalize("NFKC").toLowerCase();
}
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
function fingerprint(command: TeamMemoryWrite): string {
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify({ ...command, reviewToken: undefined }))
    .digest("hex");
}

async function access(db: Database, actor: TeamMemoryActor, lock = false): Promise<boolean> {
  const rows = await db.$queryRaw<{ role: string; teamMemoryEnabled: boolean | null }[]>(Prisma.sql`
    SELECT a."role", COALESCE(NULLIF(w.experiments->'teamMemory', 'null'::jsonb),
      ${JSON.stringify(EXPERIMENTS.teamMemory.defaultEnabled)}::jsonb) = 'true'::jsonb AS "teamMemoryEnabled"
    FROM "agents" a JOIN "workspace_memberships" m
    ON m."workspaceId" = a."workspaceId" AND m."userId" = a."ownerId"
    JOIN "workspaces" w ON w.id = a."workspaceId"
    WHERE a."id" = ${actor.agentId}::uuid AND a."workspaceId" = ${actor.workspaceId}::uuid AND a."deletedAt" IS NULL
    ${lock ? Prisma.sql`FOR SHARE OF a, m, w` : Prisma.empty}`);
  if (!rows[0]) throw new TeamMemoryError("forbidden");
  if (!rows[0].teamMemoryEnabled) throw new TeamMemoryError("disabled");
  return rows[0].role === "owner" || rows[0].role === "admin";
}

async function readTarget(db: Database, actor: TeamMemoryActor, id: string): Promise<Row> {
  const row = await db.teamMemoryEntry.findFirst({
    where: { workspaceId: actor.workspaceId, id, status: { not: "deleted" } },
  });
  if (!row) throw new TeamMemoryError("not_found");
  return row as Row;
}

async function search(
  db: Database,
  workspaceId: string,
  query: string,
  offset = 0,
): Promise<Row[]> {
  const terms = teamMemoryTerms(query);
  if (!terms.length) return [];
  const matches = terms.map((term) => Prisma.sql`search_text ILIKE ${`%${escapeLike(term)}%`}`);
  const ranks = terms.map(
    (term) =>
      Prisma.sql`CASE WHEN search_text ILIKE ${`%${escapeLike(term)}%`} THEN ${term.length > 2 ? 3 : 1} ELSE 0 END`,
  );
  return db.$queryRaw<Row[]>(Prisma.sql`
    SELECT id, workspace_id AS "workspaceId", title, left(content, 600) AS content, left(source, 200) AS source, kind, applicability, status,
      revision, author_agent_id AS "authorAgentId", updated_at AS "updatedAt"
    FROM team_memory_entries WHERE workspace_id = ${workspaceId}::uuid AND status = 'active'
    AND (${Prisma.join(matches, " OR ")})
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

  async read(
    actor: TeamMemoryActor,
    command: Exclude<TeamMemoryCommand, TeamMemoryWrite>,
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
            await search(tx, actor.workspaceId, command.query, command.offset),
            command.offset ?? 0,
            true,
          );
        if (command.operation === "list")
          return page(
            await tx.$queryRaw<
              Row[]
            >`SELECT id, workspace_id AS "workspaceId", title, left(content,600) AS content, left(source,200) AS source, kind, applicability, status, revision, author_agent_id AS "authorAgentId", updated_at AS "updatedAt" FROM team_memory_entries WHERE workspace_id = ${actor.workspaceId}::uuid AND status = ${command.archived ? "archived" : "active"} ORDER BY updated_at DESC, id ASC LIMIT 11 OFFSET ${command.offset ?? 0}`,
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
          ) AS snapshot, actor_agent_id AS "actorAgentId", operation, left(reason, 200) AS reason, merged_from AS "mergedFrom"
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
      search(db, actor.workspaceId, query),
    ]);
    const related = page(rows, 0, true);
    return { ...related, status: "ok", reviewRevision: state?.revision ?? 0 };
  }

  async review(actor: TeamMemoryActor, command: TeamMemoryWrite): Promise<TeamMemoryResult> {
    const hash = fingerprint(command);
    return this.db.$transaction(
      async (tx) => {
        await access(tx, actor);
        const query =
          "title" in command
            ? `${command.title} ${command.content} ${command.applicability}`
            : head(await readTarget(tx, actor, command.id)).title;
        const related = await this.prepare(tx, actor, query);
        const key = {
          workspaceId: actor.workspaceId,
          agentId: actor.agentId,
          requestId: command.requestId,
        };
        const existing = await tx.teamMemoryReceipt.findUnique({
          where: { workspaceId_agentId_requestId: key },
        });
        if (existing && existing.fingerprint !== hash) throw new TeamMemoryError("conflict");
        if (existing?.entryId)
          return existing.deleted
            ? { status: "deleted", entries: [], replayed: true }
            : {
                status: "ok",
                entries: [head(await readTarget(tx, actor, existing.entryId))],
                replayed: true,
              };
        const reviewToken = crypto.randomUUID();
        const data = {
          reviewToken,
          reviewRevision: related.reviewRevision!,
          reviewExpiresAt: new Date(Date.now() + 10 * 60_000),
        };
        await tx.$executeRaw`DELETE FROM team_memory_receipts WHERE (workspace_id, agent_id, request_id) IN (SELECT workspace_id, agent_id, request_id FROM team_memory_receipts WHERE workspace_id = ${actor.workspaceId}::uuid AND agent_id = ${actor.agentId}::uuid AND entry_id IS NULL AND review_expires_at < now() LIMIT 100)`;
        await tx.teamMemoryReceipt.upsert({
          where: { workspaceId_agentId_requestId: key },
          create: { ...key, fingerprint: hash, ...data },
          update: data,
        });
        return { ...related, status: "review_required", reviewToken };
      },
      { isolationLevel: "RepeatableRead" },
    );
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
          const receiptKey = {
            workspaceId: actor.workspaceId,
            agentId: actor.agentId,
            requestId: command.requestId,
          };
          const receipt = await tx.teamMemoryReceipt.findUnique({
            where: { workspaceId_agentId_requestId: receiptKey },
          });
          if (receipt && receipt.fingerprint !== hash) throw new TeamMemoryError("conflict");
          if (receipt?.entryId) {
            return receipt.deleted
              ? { status: "deleted", entries: [], replayed: true }
              : {
                  status: "ok",
                  entries: [head(await readTarget(tx, actor, receipt.entryId))],
                  replayed: true,
                };
          }
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
          validateTeamMutation(
            actor,
            command,
            target ? head(target) : undefined,
            sources.map(head),
            admin,
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
            await tx.teamMemoryReceipt.update({
              where: { workspaceId_agentId_requestId: receiptKey },
              data: {
                entryId: target!.id,
                deleted: true,
                reviewToken: null,
                reviewExpiresAt: null,
              },
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
          const data = {
            title: draft.title,
            content: draft.content,
            source: draft.source,
            kind: draft.kind,
            applicability: draft.applicability,
            dedupKey:
              command.operation === "archive" ? `archived:${target!.id}` : teamMemoryDedup(draft),
            searchText: searchText(draft),
            status: command.operation === "archive" ? "archived" : "active",
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
                data: { ...data, workspaceId: actor.workspaceId, authorAgentId: actor.agentId },
              })) as Row);
          const saved = head(target);
          await tx.teamMemoryVersion.create({
            data: {
              workspaceId: actor.workspaceId,
              entryId: target.id,
              revision: saved.revision,
              snapshot: { ...saved },
              actorAgentId: actor.agentId,
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
                actorAgentId: actor.agentId,
                operation: "merge-source",
                reason: `Merged into ${saved.id}`,
                mergedFrom: [],
              })),
            });
          }
          await tx.teamMemoryReceipt.update({
            where: { workspaceId_agentId_requestId: receiptKey },
            data: { entryId: target.id, reviewToken: null, reviewExpiresAt: null },
          });
          await tx.teamMemoryState.update({
            where: { workspaceId: actor.workspaceId },
            data: { revision: { increment: 1 } },
          });
          return { status: "ok", entries: [saved] };
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

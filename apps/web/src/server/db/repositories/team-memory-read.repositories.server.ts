import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import {
  teamMemoryTerms,
  type TeamMemoryCommand,
  type TeamMemoryMaintenanceCommand,
  type TeamMemoryCatalogCommand,
  type TeamMemoryHead,
  type TeamMemoryResult,
  type TeamMemoryWrite,
} from "@lrm/coforge-sdk/agent";
import { TeamMemoryError, type TeamMemoryActor } from "#src/server/team-memory/memory";
import { teamMemoryAccess as access } from "./team-memory-access.repositories.server";
import {
  head,
  versionHead,
  escapeLike,
  PREVIEW_WHITESPACE,
  type Row,
  type Version,
} from "./team-memory-projections.server";
import { readableMemoryEvidence } from "./team-memory-evidence.server";

type Database = PrismaClient | Prisma.TransactionClient;
export async function readTarget(db: Database, actor: TeamMemoryActor, id: string): Promise<Row> {
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
  includeSuperseded = false,
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
      revision, author_agent_id AS "authorAgentId", author_user_id AS "authorUserId", project_id AS "projectId", pinned, updated_at AS "updatedAt",
      relations, effective_at AS "effectiveAt"
    FROM team_memory_entries AS candidate WHERE workspace_id = ${workspaceId}::uuid AND status = ${archived ? "archived" : "active"}
    AND (${Prisma.join(matches, " OR ")})
    ${includeHumanAuthors ? Prisma.empty : Prisma.sql`AND author_agent_id IS NOT NULL`}
    ${projectId ? Prisma.sql`AND project_id = ${projectId}::uuid` : Prisma.empty}
    ${
      archived || includeSuperseded
        ? Prisma.empty
        : Prisma.sql`
      AND (effective_at IS NULL OR effective_at <= CURRENT_TIMESTAMP)
      AND NOT EXISTS (
        SELECT 1 FROM team_memory_entries AS replacement
        WHERE replacement.workspace_id = candidate.workspace_id
          AND replacement.status = 'active'
          AND replacement.project_id IS NOT DISTINCT FROM candidate.project_id
          AND replacement.applicability = candidate.applicability
          AND (replacement.effective_at IS NULL OR replacement.effective_at <= CURRENT_TIMESTAMP)
          ${includeHumanAuthors ? Prisma.empty : Prisma.sql`AND replacement.author_agent_id IS NOT NULL`}
          AND replacement.relations @> jsonb_build_array(
            jsonb_build_object('kind', 'supersedes', 'id', candidate.id, 'revision', candidate.revision))
      )`
    }
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

export async function projectEvidence(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  entry: TeamMemoryHead,
) {
  if (!entry.evidence?.length) return entry;
  return { ...entry, evidence: await readableMemoryEvidence(tx, workspaceId, entry.evidence) };
}

export class TeamMemoryReads {
  constructor(private readonly db: PrismaClient) {}

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
              command.includeSuperseded,
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
          if (command.revision === undefined)
            return {
              status: "ok",
              entries: [await projectEvidence(tx, actor.workspaceId, head(target))],
            };
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
          return {
            status: "ok",
            entries: [await projectEvidence(tx, actor.workspaceId, versionHead(version))],
          };
        }
        const offset = command.offset ?? 0;
        const versions = await tx.$queryRaw<Version[]>`
          SELECT (snapshot - 'evidence') || jsonb_build_object(
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

  async prepare(db: Database, actor: TeamMemoryActor, query: string): Promise<TeamMemoryResult> {
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
        true,
      ),
    ]);
    const related = page(rows, 0, true);
    return { ...related, status: "ok", reviewRevision: state?.revision ?? 0 };
  }
}

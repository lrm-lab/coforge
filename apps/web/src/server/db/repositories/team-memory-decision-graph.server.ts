import type { TeamMemoryEvidence, TeamMemoryHead } from "@lrm/coforge-sdk/agent";
import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { inTransaction } from "#src/server/db/transaction.server";
import { memoryEvidenceLinks } from "#src/server/team-memory/evidence-links.server";
import { TeamMemoryError } from "#src/server/team-memory/memory";
import { teamMemoryAccess } from "./team-memory-access.repositories.server";
import { readableMemoryEvidence } from "./team-memory-evidence.server";
import { effectiveSearchHeads } from "./team-memory-read.repositories.server";

type VersionRef = { id: string; revision: number };
type Anchor = { id: string; revision?: number };
type MemoryNode = VersionRef & {
  type: "memory";
  key: string;
  title: string;
  current: boolean;
  archived: boolean;
  scheduled: boolean;
};
type EvidenceNode = TeamMemoryEvidence & {
  type: "evidence";
  key: string;
  title?: string;
  conversationId?: string;
  taskNumber?: number;
};
type GraphEdge = {
  from: string;
  to: string;
  kind: "supports" | "supersedes" | "conflicts_with" | "revision";
};
export type TeamMemoryDecisionGraph = {
  root: string;
  nodes: (MemoryNode | EvidenceNode)[];
  edges: GraphEdge[];
};

type Decision = VersionRef &
  Pick<TeamMemoryHead, "title" | "relations" | "evidence"> & {
    status: string;
    isHead: boolean;
    effectiveAt: Date | string | null;
  };
const MAX_NEIGHBORS = 4;
const MAX_EVIDENCE = 6;
const memoryKey = ({ id, revision }: VersionRef) => `memory:${id}:${revision}`;
const versionFields = Prisma.sql`
  version.entry_id AS id, version.revision, version.snapshot->>'title' AS title,
  version.snapshot->'relations' AS relations, version.snapshot->'evidence' AS evidence,
  version.snapshot->>'effectiveAt' AS "effectiveAt", entry.status,
  version.revision = entry.revision AS "isHead"
`;
const versionTable = Prisma.sql`
  FROM team_memory_versions AS version JOIN team_memory_entries AS entry
    ON entry.id = version.entry_id AND entry.workspace_id = version.workspace_id
  WHERE entry.status IN ('active', 'archived')
`;

async function readVersions(tx: Prisma.TransactionClient, workspaceId: string, refs: VersionRef[]) {
  if (!refs.length) return [];
  return tx.$queryRaw<Decision[]>`
    SELECT ${versionFields}
    ${versionTable}
      AND version.workspace_id = ${workspaceId}::uuid
      AND (version.entry_id, version.revision) IN (
        ${Prisma.join(refs.map(({ id, revision }) => Prisma.sql`(${id}::uuid, ${revision}::integer)`))}
      )
  `;
}

const evidenceKey = (ref: TeamMemoryEvidence) => `${ref.kind}:${ref.id}:${ref.revision ?? ""}`;

async function relatedDecisions(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  root: Decision,
  latest: Decision,
) {
  const references: VersionRef[] = [...(root.relations ?? [])];
  if (root.revision < latest.revision)
    references.unshift({ id: root.id, revision: root.revision + 1 });
  if (root.revision > 1) references.push({ id: root.id, revision: root.revision - 1 });
  const wanted = new Map(references.map((item) => [memoryKey(item), item]));
  const current =
    latest.revision !== root.revision && wanted.has(memoryKey(latest)) ? [latest] : [];
  for (const record of current) wanted.delete(memoryKey(record));
  const { id, revision } = root;
  const replacesRoot = JSON.stringify([{ id, revision, kind: "supersedes" }]);
  const conflictsWithRoot = JSON.stringify([{ id, revision, kind: "conflicts_with" }]);

  const [snapshots, inbound, historical] = await Promise.all([
    readVersions(tx, workspaceId, [...wanted.values()]),
    tx.$queryRaw<Decision[]>`
      SELECT candidate.id, candidate.revision, candidate.title, candidate.relations, candidate.evidence,
        candidate.status, candidate.effective_at AS "effectiveAt", true AS "isHead"
      FROM team_memory_entries AS candidate
      WHERE candidate.workspace_id = ${workspaceId}::uuid
        AND candidate.status IN ('active', 'archived')
        AND (candidate.id, candidate.revision) <> (${id}::uuid, ${revision}::integer)
        AND (candidate.relations @> ${replacesRoot}::jsonb OR candidate.relations @> ${conflictsWithRoot}::jsonb)
      ORDER BY (
        candidate.status = 'active' AND candidate.relations @> ${replacesRoot}::jsonb
        ${effectiveSearchHeads(true)}
      ) DESC, candidate.updated_at DESC, candidate.id
      LIMIT ${MAX_NEIGHBORS}
    `,
    tx.$queryRaw<Decision[]>`
      SELECT ${versionFields}
      ${versionTable}
        AND version.workspace_id = ${workspaceId}::uuid
        AND version.revision < entry.revision
        AND (
          (version.snapshot->'relations') @> ${replacesRoot}::jsonb
          OR (version.snapshot->'relations') @> ${conflictsWithRoot}::jsonb
        )
      ORDER BY version.created_at DESC, version.entry_id, version.revision DESC
      LIMIT ${MAX_NEIGHBORS}
    `,
  ]);
  const outgoing = new Map([...snapshots, ...current].map((record) => [memoryKey(record), record]));
  const successors = [...inbound, ...historical].filter((record) =>
    record.relations?.some(
      (link) => link.kind === "supersedes" && memoryKey(link) === memoryKey(root),
    ),
  );
  const neighbors = new Map<string, Decision>();
  for (const record of [
    ...successors,
    ...references.map((item) => outgoing.get(memoryKey(item))),
    ...inbound,
    ...historical,
  ]) {
    if (record && memoryKey(record) !== memoryKey(root)) neighbors.set(memoryKey(record), record);
  }
  return [...neighbors.values()].slice(0, MAX_NEIGHBORS);
}

function decisionEdges(records: Decision[], root: Decision) {
  const keys = new Set(records.map(memoryKey));
  const edges = new Map<string, GraphEdge>();
  for (const record of records) {
    const source = memoryKey(record);
    for (const link of record.relations ?? []) {
      const target = memoryKey(link);
      if (!keys.has(target) || target === source) continue;
      const edge: GraphEdge =
        link.kind === "supersedes"
          ? { from: target, to: source, kind: link.kind }
          : { from: source, to: target, kind: link.kind };
      const [a, b] =
        link.kind === "conflicts_with" ? [source, target].sort() : [edge.from, edge.to];
      const key = `${link.kind}:${a}:${b}`;
      if (!edges.has(key)) edges.set(key, edge);
    }
    if (record.id !== root.id || Math.abs(record.revision - root.revision) !== 1) continue;
    const [from, to] =
      record.revision < root.revision ? [source, memoryKey(root)] : [memoryKey(root), source];
    edges.set(`revision:${from}:${to}`, { from, to, kind: "revision" });
  }
  return [...edges.values()];
}

export function readTeamMemoryDecisionGraph(
  db: PrismaClient,
  actor: { workspaceId: string; userId: string },
  anchor: Anchor,
): Promise<TeamMemoryDecisionGraph> {
  return inTransaction(
    db,
    async (tx) => {
      await teamMemoryAccess(tx, actor);
      const [latest] = await tx.$queryRaw<Decision[]>`
      SELECT id, revision, title, relations, evidence, status, effective_at AS "effectiveAt", true AS "isHead"
      FROM team_memory_entries WHERE workspace_id = ${actor.workspaceId}::uuid
        AND id = ${anchor.id}::uuid AND status IN ('active', 'archived')
    `;
      if (!latest) throw new TeamMemoryError("not_found");
      const [root] =
        anchor.revision !== undefined && anchor.revision !== latest.revision
          ? await readVersions(tx, actor.workspaceId, [
              { id: anchor.id, revision: anchor.revision },
            ])
          : [latest];
      if (!root) throw new TeamMemoryError("not_found");
      const records = [root, ...(await relatedDecisions(tx, actor.workspaceId, root, latest))];
      const evidenceByMemory = records.flatMap((record) =>
        (record.evidence ?? []).map((ref) => ({ ref, memory: memoryKey(record) })),
      );
      const references = new Map(evidenceByMemory.map(({ ref }) => [evidenceKey(ref), ref]));
      const [current, readable] = await Promise.all([
        tx.$queryRaw<VersionRef[]>`
        SELECT candidate.id, candidate.revision FROM team_memory_entries AS candidate
        WHERE candidate.workspace_id = ${actor.workspaceId}::uuid AND candidate.status = 'active'
          AND candidate.id = ANY(${records.map(({ id }) => id)}::uuid[])
          ${effectiveSearchHeads(true)}
      `,
        readableMemoryEvidence(tx, actor.workspaceId, [...references.values()]),
      ]);
      const knownCurrent = new Set(current.map(memoryKey));
      const readableKeys = new Set(readable.map(evidenceKey));
      const picked = new Map<string, TeamMemoryEvidence>();
      for (const record of records) {
        const visibleForRecord = (record.evidence ?? [])
          .filter((ref) => readableKeys.has(evidenceKey(ref)))
          .slice(0, record === root ? 4 : 2);
        for (const ref of visibleForRecord) picked.set(evidenceKey(ref), ref);
      }
      const visible = [...picked.values()].slice(0, MAX_EVIDENCE);
      const artifactIds = visible.filter(({ kind }) => kind === "artifact").map(({ id }) => id);
      const [links, artifacts] = await Promise.all([
        memoryEvidenceLinks(tx, actor.workspaceId, visible),
        artifactIds.length
          ? tx.artifact.findMany({
              where: { workspaceId: actor.workspaceId, id: { in: artifactIds }, deletedAt: null },
              select: { id: true, title: true, name: true },
              take: artifactIds.length,
            })
          : [],
      ]);
      const titles = new Map(artifacts.map(({ id, title, name }) => [id, title || name]));
      const evidence: EvidenceNode[] = visible.map((ref) => {
        const link = links[`${ref.kind}:${ref.id}`];
        return {
          ...ref,
          ...link,
          type: "evidence",
          key: evidenceKey(ref),
          title: link?.title ?? titles.get(ref.id),
        };
      });
      const evidenceKeys = new Set(evidence.map(({ key }) => key));
      const memoryNodes: MemoryNode[] = records.map(
        ({ id, revision, title, effectiveAt, status, isHead }) => {
          const key = memoryKey({ id, revision });
          return {
            id,
            revision,
            title,
            key,
            type: "memory",
            current: knownCurrent.has(key),
            archived: status === "archived",
            scheduled:
              isHead &&
              status !== "archived" &&
              effectiveAt !== null &&
              new Date(effectiveAt).getTime() > Date.now(),
          };
        },
      );
      return {
        root: memoryKey(root),
        nodes: [...memoryNodes, ...evidence],
        edges: [
          ...decisionEdges(records, root),
          ...evidenceByMemory.flatMap(({ ref, memory }): GraphEdge[] => {
            const from = evidenceKey(ref);
            return evidenceKeys.has(from) ? [{ from, to: memory, kind: "supports" }] : [];
          }),
        ],
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

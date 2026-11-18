import type { TeamMemoryDraft, TeamMemoryEvidence, TeamMemoryHead } from "@lrm/coforge-sdk/agent";
import type { Prisma } from "#src/generated/prisma/client";
import { readableMemoryEvidence } from "#src/server/db/repositories/team-memory-evidence.server";
import { versionHead } from "#src/server/db/repositories/team-memory-projections.server";

type Reference = { id: string; revision: number };
type Suggestion = { id: string; kind: string; payload: Prisma.JsonValue; status: string };
type Snapshot = Pick<
  TeamMemoryHead,
  "id" | "revision" | "title" | "content" | "source" | "evidence" | "projectId"
>;

function sources(row: Suggestion): Reference[] {
  if (row.kind === "duplicate") {
    const { keep, duplicate } = row.payload as { keep: Reference; duplicate: Reference };
    return [keep, duplicate];
  }
  if (row.kind === "evidence") return [row.payload as Reference];
  const draft = row.payload as { operation?: string; id?: string; revision?: number };
  return draft.operation === "update" && draft.id && draft.revision
    ? [{ id: draft.id, revision: draft.revision }]
    : [];
}

const draftOf = (row: Suggestion) =>
  row.kind === "draft" || row.kind === "task"
    ? (row.payload as unknown as TeamMemoryDraft)
    : undefined;

const revisionKey = ({ id, revision }: Reference) => `${id}:${revision}`;
const evidenceKey = ({ kind, id, revision }: TeamMemoryEvidence) => `${kind}:${id}:${revision}`;

export async function memorySuggestionPreviews<T extends Suggestion>(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  rows: T[],
) {
  const references = rows.flatMap(sources);
  const versions = references.length
    ? await tx.teamMemoryVersion.findMany({
        where: {
          workspaceId,
          entry: { status: { not: "deleted" } },
          OR: references.map(({ id, revision }) => ({ entryId: id, revision })),
        },
        take: references.length,
      })
    : [];
  const byRevision = new Map(
    versions.map((row) => {
      const snapshot = versionHead(row);
      return [revisionKey(snapshot), snapshot];
    }),
  );
  const projectIds = [
    ...new Set(
      [
        ...rows.map((row) => draftOf(row)?.projectId),
        ...Array.from(byRevision.values()).map(({ projectId }) => projectId),
      ].filter((id): id is string => !!id),
    ),
  ];
  const projects = projectIds.length
    ? await tx.project.findMany({
        where: { workspaceId, id: { in: projectIds } },
        select: { id: true, name: true },
        take: projectIds.length,
      })
    : [];
  const projectNames = new Map(projects.map(({ id, name }) => [id, name]));
  const draftEvidence = (row: Suggestion) => draftOf(row)?.evidence ?? [];
  const readable = new Set(
    (
      await readableMemoryEvidence(tx, workspaceId, [
        ...rows.flatMap(draftEvidence),
        ...Array.from(byRevision.values()).flatMap(({ evidence }) => evidence ?? []),
      ])
    ).map(evidenceKey),
  );
  const visibleEvidence = (references: TeamMemoryEvidence[]) =>
    references.filter((reference) => readable.has(evidenceKey(reference)));
  return rows.map((row) => {
    const evidence = visibleEvidence(draftEvidence(row));
    const base = sources(row);
    const snapshots = base.flatMap((ref): Snapshot[] => {
      const snapshot = byRevision.get(revisionKey(ref));
      if (!snapshot) return [];
      const { id, revision, title, content, source, projectId } = snapshot;
      return [
        {
          id,
          revision,
          title,
          content,
          source,
          projectId,
          evidence: visibleEvidence(snapshot.evidence ?? []),
        },
      ];
    });
    const { payload, ...metadata } = row;
    const draft = draftOf(row);
    const projectId = draft?.projectId ?? snapshots[0]?.projectId;
    return {
      ...metadata,
      payload: draft ? { ...draft, evidence } : payload,
      projectName: projectId ? projectNames.get(projectId) : undefined,
      evidence,
      snapshots,
      blocked: evidence.length !== draftEvidence(row).length || snapshots.length !== base.length,
    };
  });
}

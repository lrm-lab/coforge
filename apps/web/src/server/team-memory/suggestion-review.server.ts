import {
  decodeTeamMemoryCommand,
  type TeamMemoryDraft,
  type TeamMemoryWrite,
} from "@lrm/coforge-sdk/agent";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { activeMemoryCandidateIds } from "#src/server/db/repositories/team-memory-head-filters.server";
import { teamMemoryAccess } from "#src/server/db/repositories/team-memory-access.repositories.server";
import { readableMemoryEvidence } from "#src/server/db/repositories/team-memory-evidence.server";
import { head, type Row } from "#src/server/db/repositories/team-memory-projections.server";
import { PrismaTeamMemoryStore } from "#src/server/db/repositories/team-memory.repositories.server";
import { TeamMemoryError } from "./memory";
import { memorySuggestionPreviews } from "./suggestion-previews.server";
import { memoryEvidenceLinks } from "./evidence-links.server";

type Reviewer = { workspaceId: string; userId: string };
type Suggestion = { id: string; kind: string; payload: Prisma.JsonValue };
type Edit = Pick<Partial<TeamMemoryDraft>, "title" | "content">;

export async function submitMemorySuggestion(db: PrismaClient, actor: Reviewer, input: unknown) {
  let command;
  try {
    command = decodeTeamMemoryCommand(input);
  } catch {
    throw new TeamMemoryError("invalid");
  }
  if (command.operation !== "create" && command.operation !== "update")
    throw new TeamMemoryError("invalid");
  if (command.reviewToken || command.maintenanceToken) throw new TeamMemoryError("invalid");
  return db.$transaction(async (tx) => {
    await teamMemoryAccess(tx, actor, true);
    if (command.operation === "update") {
      const target = await tx.teamMemoryEntry.findFirst({
        where: {
          workspaceId: actor.workspaceId,
          id: command.id,
          revision: command.revision,
          status: { not: "deleted" },
        },
        select: { id: true },
      });
      if (!target) throw new TeamMemoryError("conflict");
    }
    if (
      command.evidence?.length &&
      (await readableMemoryEvidence(tx, actor.workspaceId, command.evidence)).length !==
        command.evidence.length
    )
      throw new TeamMemoryError("forbidden");
    await tx.teamMemorySuggestion.createMany({
      data: {
        workspaceId: actor.workspaceId,
        sourceKey: `draft:${actor.userId}:${command.requestId}`,
        kind: "draft",
        payload: command,
      },
      skipDuplicates: true,
    });
    return { status: "queued" as const };
  });
}

export async function listMemorySuggestions(db: PrismaClient, actor: Reviewer, after?: string) {
  return db.$transaction(
    async (tx) => {
      await teamMemoryAccess(tx, actor);
      const rows = await tx.teamMemorySuggestion.findMany({
        where: {
          workspaceId: actor.workspaceId,
          status: { in: ["pending", "verification"] },
          ...(after ? { id: { gt: after } } : {}),
        },
        select: { id: true, kind: true, payload: true, status: true, createdAt: true },
        orderBy: { id: "asc" },
        take: 21,
      });
      const page = rows.slice(0, 20);
      const refs = page.flatMap((row) => {
        if (row.kind !== "task") return [];
        const draft = row.payload as unknown as TeamMemoryDraft;
        return draft.evidence ?? [];
      });
      const current = refs.length
        ? await tx.task.findMany({
            where: {
              id: { in: refs.map(({ id }) => id) },
              workspaceId: actor.workspaceId,
              status: "done",
              deletedAt: null,
              conversation: {
                channelName: { not: null },
                visibility: "public",
                hiddenFromWorkspaceAt: null,
              },
            },
            select: { id: true, revision: true },
            take: refs.length,
          })
        : [];
      const readable = new Set(current.map(({ id, revision }) => `${id}:${revision}`));
      const available = page.filter(
        (row) =>
          row.kind !== "task" ||
          (row.payload as unknown as TeamMemoryDraft).evidence?.every(({ id, revision }) =>
            readable.has(`${id}:${revision}`),
          ),
      );
      const previews = await memorySuggestionPreviews(tx, actor.workspaceId, available);
      const evidenceLinks = await memoryEvidenceLinks(
        tx,
        actor.workspaceId,
        previews.flatMap((row) => [
          ...row.evidence,
          ...row.snapshots.flatMap(({ evidence }) => evidence ?? []),
        ]),
      );
      return {
        rows: previews,
        evidenceLinks,
        next: rows.length > 20 ? rows[19]?.id : undefined,
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
}

export async function reviewMemorySuggestion(
  db: PrismaClient,
  actor: Reviewer,
  id: string,
  decision: "accept" | "dismiss" | "verify",
  edit?: Edit,
) {
  const { batchId, ...result } = await db.$transaction(
    async (tx) => {
      const key = { id, workspaceId: actor.workspaceId };
      let currentTask = false;
      if (decision === "accept") {
        await teamMemoryAccess(tx, actor);
        const draft = await tx.teamMemorySuggestion.findUnique({ where: key });
        if (draft?.kind === "task" && ["pending", "verification"].includes(draft.status))
          currentTask = await lockTaskSuggestionSource(tx, actor.workspaceId, draft);
      }
      await teamMemoryAccess(tx, actor, true);
      const [locked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM team_memory_suggestions
      WHERE id = ${id}::uuid AND workspace_id = ${actor.workspaceId}::uuid FOR UPDATE`;
      if (!locked) throw new TeamMemoryError("not_found");
      const row = await tx.teamMemorySuggestion.findUniqueOrThrow({ where: key });
      if (row.status !== "pending" && row.status !== "verification")
        return { status: row.status, entryId: row.appliedEntryId };
      if (decision === "verify") {
        await tx.teamMemorySuggestion.update({ where: key, data: { status: "verification" } });
        return { status: "verification", entryId: null };
      }
      const decided = { decidedAt: new Date(), decidedByUserId: actor.userId };
      if (decision === "dismiss") {
        await tx.teamMemorySuggestion.update({
          where: key,
          data: { ...decided, status: "dismissed" },
        });
        return { status: "dismissed", entryId: null };
      }
      if (row.kind === "duplicate" || row.kind === "evidence")
        await tx.$queryRaw`SELECT revision FROM team_memory_states WHERE workspace_id = ${actor.workspaceId}::uuid FOR UPDATE`;
      const command =
        row.kind !== "task" || currentTask
          ? await suggestedCommand(tx, actor.workspaceId, row, edit)
          : undefined;
      if (!command) {
        await tx.teamMemorySuggestion.update({ where: key, data: { ...decided, status: "stale" } });
        return { status: "stale", entryId: null };
      }
      const applied = await new PrismaTeamMemoryStore(tx).write(actor, command, {
        skipReview: true,
        skipProjection: true,
      });
      const entryId = applied.entries[0]?.id ?? null;
      await tx.teamMemorySuggestion.update({
        where: key,
        data: { ...decided, status: "accepted", appliedEntryId: entryId },
      });
      return { status: "accepted", entryId, batchId: row.scanId };
    },
    { timeout: 10_000 },
  );
  if (batchId)
    console.info(
      JSON.stringify({
        event: "team_memory.review_scan_accepted",
        workspace_id: actor.workspaceId,
        scan_id: batchId,
        suggestion_id: id,
        accepted: 1,
      }),
    );
  return result;
}

async function lockTaskSuggestionSource(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  row: Suggestion,
) {
  const source = (row.payload as unknown as TeamMemoryDraft).evidence?.[0];
  if (!source) return false;
  const [task] = await tx.$queryRaw<{ id: string }[]>`
    SELECT t.id FROM tasks t JOIN conversations c
      ON c.id = t."conversationId" AND c."workspaceId" = t."workspaceId"
    WHERE t.id = ${source.id}::uuid AND t."workspaceId" = ${workspaceId}::uuid
      AND t."deletedAt" IS NULL AND t.status = 'done' AND t.revision = ${source.revision ?? 0}
      AND c."channelName" IS NOT NULL AND c.visibility = 'public'
      AND c."hiddenFromWorkspaceAt" IS NULL
    FOR SHARE OF c, t`;
  return !!task;
}

async function suggestedCommand(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  row: Suggestion,
  edit?: Edit,
): Promise<TeamMemoryWrite | undefined> {
  if (row.kind === "draft") {
    const command = row.payload as unknown as Extract<
      TeamMemoryWrite,
      { operation: "create" | "update" }
    >;
    if (command.operation === "update") {
      const target = await tx.teamMemoryEntry.findFirst({
        where: {
          workspaceId,
          id: command.id,
          revision: command.revision,
          status: { not: "deleted" },
        },
        select: { id: true },
      });
      if (!target) return undefined;
    }
    if (
      command.evidence?.length &&
      (await readableMemoryEvidence(tx, workspaceId, command.evidence)).length !==
        command.evidence.length
    )
      return undefined;
    return decodeTeamMemoryCommand({ ...command, ...edit, requestId: row.id }) as TeamMemoryWrite;
  }
  if (row.kind === "task") {
    const draft = row.payload as unknown as TeamMemoryDraft;
    return decodeTeamMemoryCommand({
      ...draft,
      ...edit,
      operation: "create",
      requestId: row.id,
    }) as TeamMemoryWrite;
  }
  if (row.kind === "evidence") {
    const { id, revision } = row.payload as unknown as { id: string; revision: number };
    if (!(await activeMemoryCandidateIds(tx, workspaceId, [id])).has(id)) return undefined;
    const entry = await tx.teamMemoryEntry.findFirst({
      where: { id, revision, workspaceId, status: "active", pinned: false },
    });
    if (!entry) return undefined;
    const current = head(entry as Row);
    const evidence = await readableMemoryEvidence(tx, workspaceId, current.evidence ?? []);
    return decodeTeamMemoryCommand({
      operation: "update",
      requestId: row.id,
      id,
      revision,
      title: edit?.title ?? current.title,
      content: edit?.content ?? current.content,
      applicability: current.applicability,
      kind: current.kind,
      projectId: current.projectId,
      source: "Reconfirmed during team memory review",
      evidence,
      reason: "Reconfirmed after evidence became unavailable",
    }) as TeamMemoryWrite;
  }
  if (row.kind !== "duplicate") return undefined;
  const { keep, duplicate } = row.payload as unknown as {
    keep: { id: string; revision: number };
    duplicate: { id: string; revision: number };
  };
  const eligible = await activeMemoryCandidateIds(tx, workspaceId, [keep.id, duplicate.id]);
  if (eligible.size !== 2) return undefined;
  const rows = await tx.teamMemoryEntry.findMany({
    where: { workspaceId, id: { in: [keep.id, duplicate.id] }, status: "active", pinned: false },
    take: 2,
  });
  const target = rows.find((entry) => entry.id === keep.id && entry.revision === keep.revision);
  const source = rows.find(
    (entry) => entry.id === duplicate.id && entry.revision === duplicate.revision,
  );
  if (!target || !source) return undefined;
  const retained = head(target as Row);
  const other = head(source as Row);
  const refs = new Map(
    [...(retained.evidence ?? []), ...(other.evidence ?? [])].map((ref) => [
      JSON.stringify(ref),
      ref,
    ]),
  );
  if (refs.size > 8) return undefined;
  const evidence = await readableMemoryEvidence(tx, workspaceId, [...refs.values()]);
  return decodeTeamMemoryCommand({
    ...edit,
    operation: "merge",
    requestId: row.id,
    ...keep,
    sources: [duplicate],
    title: edit?.title ?? retained.title,
    content: edit?.content ?? retained.content,
    source: [retained.source, other.source]
      .filter((text, i, list) => i === list.indexOf(text))
      .join("\n")
      .slice(0, 1_000),
    kind: retained.kind,
    applicability: retained.applicability,
    projectId: retained.projectId,
    evidence,
    reason: "Reviewed duplicate team memory",
  }) as TeamMemoryWrite;
}

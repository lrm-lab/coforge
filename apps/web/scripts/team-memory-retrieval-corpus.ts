import { z } from "zod";
import type { PrismaClient } from "#src/generated/prisma/client";
import { teamMemory } from "#src/server/team-memory/composition.server";
import type { TeamMemoryActor } from "#src/server/team-memory/memory";
import type { TeamMemoryDraft, TeamMemoryWrite } from "@lrm/coforge-sdk/agent";

const key = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(100);
const document = z.object({
  id: key,
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(16_000),
  applicability: z.string().trim().max(200).default(""),
  project: key.optional(),
  supersedes: z.array(key).optional(),
  status: z.enum(["active", "archived"]).default("active"),
  effectiveAt: z.iso.datetime().optional(),
});
const question = z.object({
  id: key,
  category: z.enum(["identifier", "paraphrase", "cross-language", "revision"]),
  query: z.string().trim().min(1).max(500),
  project: key.optional(),
  relevant: z.array(key).min(1),
  obsolete: z.array(key).default([]),
});
const corpus = z.object({
  dataset: z.enum(["synthetic", "observed"]),
  documents: z.array(document).min(1),
  questions: z.array(question).min(1),
});

export type RetrievalCorpus = z.infer<typeof corpus>;

export function parseRetrievalCorpus(input: unknown): RetrievalCorpus {
  const parsed = corpus.parse(input);
  const documentIds = new Set<string>();
  for (const doc of parsed.documents) {
    if (documentIds.has(doc.id) || doc.supersedes?.some((id) => !documentIds.has(id)))
      throw new Error(`Duplicate document or unknown preceding version: ${doc.id}`);
    documentIds.add(doc.id);
  }
  const questionIds = new Set<string>();
  for (const item of parsed.questions) {
    const labels = [...item.relevant, ...item.obsolete];
    if (
      questionIds.has(item.id) ||
      new Set(labels).size !== labels.length ||
      labels.some((id) => !documentIds.has(id))
    )
      throw new Error(`Duplicate question or invalid document labels: ${item.id}`);
    questionIds.add(item.id);
  }
  return parsed;
}

export async function seedRetrievalCorpus(
  db: PrismaClient,
  actor: TeamMemoryActor,
  input: RetrievalCorpus,
) {
  const memory = teamMemory(db);
  const projects = new Map<string, string>();
  const labels = new Map<string, string>();
  const entries = new Map<string, { id: string; revision: number }>();
  const scopeNames = new Set([
    ...input.documents.flatMap((doc) => doc.project ?? []),
    ...input.questions.flatMap((item) => item.project ?? []),
  ]);
  for (const slug of scopeNames) {
    const result = await memory.execute(actor, {
      operation: "project-create",
      name: slug,
      slug,
      description: "",
    });
    const project = result.projects?.[0];
    if (!project) throw new Error(`Missing evaluation project: ${slug}`);
    projects.set(slug, project.id);
  }
  const lastReference = new Map<string, string>();
  for (const doc of input.documents) {
    for (const label of doc.supersedes ?? []) lastReference.set(label, doc.id);
  }
  const archiveAfter = new Map<string, string[]>();
  for (const doc of input.documents) {
    if (doc.status !== "archived") continue;
    const after = lastReference.get(doc.id) ?? doc.id;
    archiveAfter.set(after, [...(archiveAfter.get(after) ?? []), doc.id]);
  }
  for (const doc of input.documents) {
    const relations = doc.supersedes?.map((label) => ({
      kind: "supersedes" as const,
      ...entries.get(label)!,
    }));
    const draft: TeamMemoryDraft = {
      title: doc.title,
      content: doc.content,
      applicability: doc.applicability,
      kind: "decision",
      source: "Retrieval evaluation fixture",
      projectId: doc.project ? projects.get(doc.project)! : null,
      ...(relations?.length ? { relations } : {}),
      ...(doc.effectiveAt ? { effectiveAt: doc.effectiveAt } : {}),
    };
    const write: TeamMemoryWrite = {
      operation: "create",
      requestId: crypto.randomUUID(),
      ...draft,
    };
    const review = await memory.execute(actor, write);
    if (!review.reviewToken) throw new Error(`Could not review evaluation memory: ${doc.id}`);
    const result = await memory.execute(actor, { ...write, reviewToken: review.reviewToken });
    const entry = result.entries[0];
    if (!entry || labels.has(entry.id)) throw new Error(`Duplicate evaluation memory: ${doc.id}`);
    entries.set(doc.id, { id: entry.id, revision: entry.revision });
    labels.set(entry.id, doc.id);
    for (const label of archiveAfter.get(doc.id) ?? []) {
      const archive: TeamMemoryWrite = {
        operation: "archive",
        requestId: crypto.randomUUID(),
        reason: "Archived evaluation fixture",
        ...entries.get(label)!,
      };
      const archived = await memory.execute(actor, archive);
      if (!archived.reviewToken) throw new Error(`Could not review archival of ${label}`);
      await memory.execute(actor, { ...archive, reviewToken: archived.reviewToken });
    }
  }
  return { labels, projects };
}

export async function useCorpusSearchMarker<T>(
  db: PrismaClient,
  workspaceId: string,
  read: (marker: string) => Promise<T>,
): Promise<T> {
  const suffix = ` retrievalevaluation${crypto.randomUUID().replaceAll("-", "")}`;
  await db.$executeRaw`
    UPDATE team_memory_entries SET search_text = search_text || ${suffix}
    WHERE workspace_id = ${workspaceId}::uuid
  `;
  try {
    return await read(suffix.trim());
  } finally {
    await db.$executeRaw`
      UPDATE team_memory_entries SET search_text = left(search_text, -${suffix.length}::integer)
      WHERE workspace_id = ${workspaceId}::uuid AND right(search_text, ${suffix.length}::integer) = ${suffix}
    `;
  }
}

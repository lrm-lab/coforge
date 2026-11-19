import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import { PrismaClient } from "#src/generated/prisma/client";
import { teamMemory } from "#src/server/team-memory/composition.server";
import { TASK_MEMORY_RECALL_MS } from "#src/server/tasks/task-memory-recall.server";
import {
  parseRetrievalCorpus,
  seedRetrievalCorpus,
  useCorpusSearchMarker,
  type RetrievalCorpus,
} from "./team-memory-retrieval-corpus";
import {
  RETRIEVAL_LIMIT,
  fuseRetrievalRanks,
  summarizeRetrieval,
} from "./team-memory-retrieval-ranking";

const MODEL = "Qwen3-Embedding-0.6B-Q4_K_M-imat";
const DIMENSIONS = 1_024;
const embeddingResponse = z.object({
  model: z.literal(MODEL),
  data: z.tuple([z.object({ embedding: z.array(z.number()).length(DIMENSIONS) })]),
});
const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
type TimedRanking = { ranked: string[]; ms: number };
type QueryResult = Pick<
  RetrievalCorpus["questions"][number],
  "id" | "category" | "relevant" | "obsolete"
> & {
  keyword: TimedRanking;
  hybrid: TimedRanking;
};

function evaluationDatabaseUrl() {
  const raw = Bun.env.TEAM_MEMORY_EVAL_DATABASE_URL;
  const url = raw ? URL.parse(raw) : null;
  if (
    !url ||
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !loopback.has(url.hostname) ||
    !/^\/coforge_memory_eval(?:_[a-z0-9]+)?$/.test(url.pathname) ||
    url.search
  )
    throw new Error(
      "Set TEAM_MEMORY_EVAL_DATABASE_URL to a disposable local coforge_memory_eval database",
    );
  return url.href;
}

async function embed(input: string) {
  const response = await fetch("http://127.0.0.1:14242/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input, model: MODEL }),
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Local embedding service returned HTTP ${response.status}`);
  const { embedding } = embeddingResponse.parse(await response.json()).data[0];
  const norm = Math.hypot(...embedding);
  if (!norm) throw new Error("Local embedding service returned a zero vector");
  return embedding.map((value) => value / norm);
}

function semanticRanks(query: readonly number[], candidates: Map<string, number[]>) {
  return [...candidates]
    .map(([id, vector]) => ({
      id,
      score: vector.reduce((dot, value, index) => dot + value * query[index]!, 0),
    }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, RETRIEVAL_LIMIT)
    .map(({ id }) => id);
}

async function evaluate(path: string) {
  const input = parseRetrievalCorpus(await Bun.file(path).json());
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: evaluationDatabaseUrl() }),
  });
  const run = `retrieval-eval-${crypto.randomUUID()}`;
  let userId: string | undefined;
  let workspaceId: string | undefined;
  try {
    const user = await db.user.create({
      data: { username: run, displayName: "Retrieval evaluation" },
    });
    userId = user.id;
    const workspace = await db.workspace.create({
      data: {
        slug: run,
        name: "Retrieval evaluation",
        members: { create: { userId, role: "owner" } },
      },
    });
    workspaceId = workspace.id;
    const actor = { workspaceId, userId };
    const memory = teamMemory(db);
    const { labels, projects } = await seedRetrievalCorpus(db, actor, input);
    const projectScopes = new Set(input.questions.map((item) => item.project));
    const matchScope = (project: string | undefined) =>
      project ? { projectId: projects.get(project)!, includeWorkspace: true } : { projectId: null };
    const allowedByProject = await useCorpusSearchMarker(db, workspace.id, async (marker) => {
      const scopes = new Map<string | undefined, Set<string>>();
      for (const project of projectScopes) {
        const allowed = new Set<string>();
        let offset: number | undefined = 0;
        while (offset !== undefined) {
          const page = await memory.execute(actor, {
            operation: "search",
            query: marker,
            offset,
            ...matchScope(project),
          });
          for (const entry of page.entries) allowed.add(labels.get(entry.id)!);
          offset = page.nextOffset;
        }
        scopes.set(project, allowed);
      }
      return scopes;
    });
    const vectors = new Map<string, number[]>();
    const corpusByProject = new Map<string | undefined, Map<string, number[]>>();
    for (const [project, allowed] of allowedByProject) {
      const candidates = new Map<string, number[]>();
      for (const doc of input.documents) {
        if (!allowed.has(doc.id)) continue;
        const vector =
          vectors.get(doc.id) ??
          (await embed(`${doc.title}\n${doc.content}\n${doc.applicability}`));
        vectors.set(doc.id, vector);
        candidates.set(doc.id, vector);
      }
      corpusByProject.set(project, candidates);
    }

    const keywordSearch = async (item: RetrievalCorpus["questions"][number]) => {
      const result = await memory.execute(actor, {
        operation: "search",
        query: item.query,
        ...matchScope(item.project),
        includeConflicts: true,
      });
      return result.entries.slice(0, RETRIEVAL_LIMIT).map(({ id }) => labels.get(id)!);
    };
    await keywordSearch(input.questions[0]!);
    const results: QueryResult[] = [];
    for (const item of input.questions) {
      const candidates = corpusByProject.get(item.project)!;
      for (const id of item.relevant)
        if (!candidates.has(id))
          throw new Error(`Relevant decision ${id} is outside the effective scope of ${item.id}`);
      const keywordStart = performance.now();
      const keyword: TimedRanking = {
        ranked: await keywordSearch(item),
        ms: performance.now() - keywordStart,
      };
      const hybridStart = performance.now();
      const [lexical, vector] = await Promise.all([
        keywordSearch(item),
        embed(
          `Instruct: Given a work question, retrieve relevant team decisions that answer it.\nQuery: ${item.query}`,
        ),
      ]);
      const hybrid: TimedRanking = {
        ranked: fuseRetrievalRanks(lexical, semanticRanks(vector, candidates)),
        ms: performance.now() - hybridStart,
      };
      const { id, category, relevant, obsolete } = item;
      results.push({ id, category, relevant, obsolete, keyword, hybrid });
    }

    function summarize(rows: typeof results) {
      return {
        keyword: summarizeRetrieval(
          rows.map(({ relevant, obsolete, keyword }) => ({ relevant, obsolete, ...keyword })),
        ),
        hybrid: summarizeRetrieval(
          rows.map(({ relevant, obsolete, hybrid }) => ({ relevant, obsolete, ...hybrid })),
        ),
      };
    }
    const categories = new Set(results.map(({ category }) => category));
    return {
      dataset: input.dataset,
      model: MODEL,
      dimensions: DIMENSIONS,
      recallBudgetMs: TASK_MEMORY_RECALL_MS,
      overall: summarize(results),
      byCategory: Object.fromEntries(
        [...categories].map((category) => [
          category,
          summarize(results.filter((result) => result.category === category)),
        ]),
      ),
      results,
    };
  } finally {
    try {
      if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
      if (userId) await db.user.delete({ where: { id: userId } });
    } finally {
      await db.$disconnect();
    }
  }
}

if (import.meta.main) {
  const [path, ...rest] = Bun.argv.slice(2);
  if (!path || rest.length)
    throw new Error("Usage: bun apps/web/scripts/eval-team-memory-retrieval.ts <corpus.json>");
  console.log(JSON.stringify(await evaluate(path), null, 2));
}

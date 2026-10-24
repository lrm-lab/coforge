import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTaskDocTools, taskAgentTools } from "../src/task-doc-tools";

const requests: { method: string; path: string; headers: Headers; body: unknown }[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        path: url.pathname + url.search,
        headers: request.headers,
        body: request.method === "POST" ? await request.json() : undefined,
      });
      if (url.pathname === "/api/v1/search/find")
        return Response.json({
          result: {
            retrieval_mode: "bm25",
            chain_ref: "chain-1",
            step: 0,
            remaining_hops: 3,
            exhausted: false,
            resources: [
              {
                uri: "viking://resources/evo-ir/documents/doc-1.md",
                excerpt: "x".repeat(900),
                score: 3.2,
                content_hash: "sha256:abc",
                level: 2,
                metadata: { kind: "document" },
              },
            ],
          },
        });
      if (url.pathname === "/api/v1/content/read") return Response.json({ result: "full text" });
      return new Response("nope", { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));

const env = () => ({
  COFORGE_EVAL_TASK_DOC_TOOLS: "1",
  COFORGE_EVAL_OV_BASE_URL: `http://127.0.0.1:${server.port}/`,
  COFORGE_EVAL_OV_ACCOUNT_ID: "corpus",
  COFORGE_EVAL_OV_ACCOUNT_KEY: "secret",
  COFORGE_EVAL_TASK_FIND_CAP: "1",
});

async function run(tool: unknown, params: unknown) {
  const result = await (tool as { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[] }> }).execute("t", params);
  return JSON.parse(result.content[0]!.text);
}

test("document tools are absent unless the eval flag is set", () => {
  expect(createTaskDocTools({})).toEqual([]);
  expect(() => createTaskDocTools({ COFORGE_EVAL_TASK_DOC_TOOLS: "1" })).toThrow(/require/);
});

test("ov_find queries the corpus instance in BM25 mode with the corpus account and shortens long excerpts", async () => {
  const [find] = createTaskDocTools(env());
  requests.length = 0;
  const out = await run(find, { operationId: "find-1", query: "actor antagonist rural village", limit: 5 });
  expect(requests[0]!.path).toBe("/api/v1/search/find");
  expect(requests[0]!.body).toMatchObject({ retrieval_mode: "bm25", limit: 5 });
  expect(requests[0]!.headers.get("x-openviking-account")).toBe("corpus");
  expect(requests[0]!.headers.get("authorization")).toBe("Bearer secret");
  expect(out.items[0].citationId).toBe("ov:evo-ir/documents/doc-1.md");
  expect(out.items[0].excerpt.length).toBe(480);
  expect(out.discoveryNotes[0].note).toContain("ov_read");
  expect(out.retrieval.chainRef).toBe("chain-1");
});

test("the per-episode find budget turns an overflow into a publish-now instruction", async () => {
  const [find, read] = createTaskDocTools(env());
  await run(find, { operationId: "find-1", query: "first" });
  const over = await run(find, { operationId: "find-2", query: "second" });
  expect(over.error).toContain("document_budget_exhausted");
  expect(over.error).toContain("coforge message send");
  const doc = await run(read, { operationId: "read-1", uri: "viking://resources/evo-ir/documents/doc-1.md" });
  expect(doc.content).toBe("full text");
  expect(doc.citation.citationId).toBe("ov:evo-ir/documents/doc-1.md");
});

test("taskAgentTools always carries the Memory Hint receipt and adds documents only when enabled", () => {
  const proxy = { post: async () => ({}) };
  const names = (tools: unknown[]) => tools.map((tool) => (tool as { name: string }).name);
  const before = { ...Bun.env };
  delete Bun.env.COFORGE_EVAL_TASK_DOC_TOOLS;
  try {
    expect(names(taskAgentTools(proxy, {}))).toEqual(["memory_disposition"]);
    expect(names(taskAgentTools(proxy, env()))).toEqual(["memory_disposition", "ov_find", "ov_read"]);
    expect(names(taskAgentTools(proxy, env(), { memoryControlSession: true }))).toEqual([
      "memory_disposition",
    ]);
  } finally {
    Object.assign(Bun.env, before);
  }
});

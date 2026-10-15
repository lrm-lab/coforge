import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvalRuntime, userIdentity } from "../../public-channel-memory/src/ov";
import { importKnowledgeResource, prepareKnowledge } from "../src/knowledge-import";

const identity = userIdentity("prepared", "owner", "test-key", "admin");

test("BM25 preparation uploads projected raw documents and resumes without embedding jobs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lexical-ready-"));
  const posted: { uri: string; text: string; kind: string }[] = [];
  let extraCounts = {};
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/api/v1/search/index_lexical");
      if (request.method === "GET")
        return Response.json({
          status: "ok",
          result: { retrieval_mode: "bm25", document: 1, ...extraCounts },
        });
      const body = (await request.json()) as {
        resources: { uri: string; text: string; kind: string }[];
      };
      posted.push(...body.resources);
      return Response.json({
        status: "ok",
        result: {
          retrieval_mode: "bm25",
          resources: body.resources.map((row) => ({
            uri: row.uri,
            content_hash: "sha256:" + new Bun.CryptoHasher("sha256").update(row.text).digest("hex"),
          })),
        },
      });
    },
  });
  try {
    const corpusPath = join(dir, "corpus.jsonl"),
      ledgerPath = join(dir, "ledger.json"),
      readyPath = join(dir, "ready.json");
    await Bun.write(
      corpusPath,
      JSON.stringify({ docid: "d1", text: "Evidence", answer: "hidden-answer", gold: true }) + "\n",
    );
    await Bun.write(ledgerPath, "[]");
    const input = {
      runtime: createEvalRuntime(server.url.toString()),
      identity,
      accountCreatedAt: "2026-10-15T00:00:00Z",
      corpusPath,
      ledgerPath,
      readyPath,
      expectedDocuments: 1,
      expectedExperiences: 0,
    };
    expect((await prepareKnowledge(input)).arm).toBe("cold");
    await prepareKnowledge(input);
    extraCounts = { native_block: 1 };
    await expect(prepareKnowledge(input)).rejects.toThrow("untracked resource kinds");
    expect(await Bun.file(readyPath).exists()).toBe(false);
    extraCounts = {};
    expect(posted).toEqual([
      { uri: "viking://resources/evo-ir/documents/d1.md", text: "Evidence", kind: "document" },
    ]);
    await expect(
      prepareKnowledge({ ...input, accountCreatedAt: "2026-10-16T00:00:00Z" }),
    ).rejects.toThrow("checkpoint input/account mismatch");
    expect(await Bun.file(readyPath).exists()).toBe(false);
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test("raw import refuses a backend without BM25 provenance or a matching content hash", async () => {
  let result: unknown = { resources: [] };
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({ status: "ok", result });
    },
  });
  try {
    const resource = { uri: "viking://resources/evo-ir/documents/d1.md", text: "Evidence" };
    const invoke = () =>
      importKnowledgeResource(createEvalRuntime(server.url.toString()), identity, resource);
    await expect(invoke()).rejects.toThrow("requires verified BM25");
    result = {
      retrieval_mode: "bm25",
      resources: [{ uri: resource.uri, content_hash: "sha256:wrong" }],
    };
    await expect(invoke()).rejects.toThrow("content hash mismatch");
  } finally {
    server.stop(true);
  }
});

test("large raw document batches respect the existing transport byte cap", async () => {
  const posted: string[][] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { resources } = (await request.json()) as {
        resources: { uri: string; text: string }[];
      };
      posted.push(resources.map((row) => row.uri));
      return Response.json({
        status: "ok",
        result: {
          retrieval_mode: "bm25",
          resources: resources.map((row) => ({
            uri: row.uri,
            content_hash: "sha256:" + new Bun.CryptoHasher("sha256").update(row.text).digest("hex"),
          })),
        },
      });
    },
  });
  try {
    const { importKnowledgeResources } = await import("../src/knowledge-import");
    const rows = ["a", "b"].map((id) => ({
      uri: `viking://resources/docs/${id}.md`,
      text: "x".repeat(4_300_000),
    }));
    await importKnowledgeResources(createEvalRuntime(server.url.toString()), identity, rows);
    expect(posted).toEqual(rows.map((row) => [row.uri]));
  } finally {
    server.stop(true);
  }
});

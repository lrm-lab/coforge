import { expect, test } from "bun:test";
import { OPENVIKING_CITATION_KIND } from "@lrm/coforge-sdk/agent";
import type { OpenVikingCitationRecord } from "../db/repositories/workspace-memory-citation.repositories.server";
import { createMemoryCitationBindings } from "../workspace-memory/memory-citations";
import { RetiredFromMemoryDiscoveryError } from "../workspace-memory/memory-discovery-eligibility";
import { createOpenVikingMemoryReads } from "./openviking-memory-reads";
import type { OpenVikingMemoryReadInvocation } from "./memory-agent-reads";

function harness(results: unknown) {
  const calls: OpenVikingMemoryReadInvocation[] = [];
  const ovRows = new Map<string, OpenVikingCitationRecord>();
  const citations = createMemoryCitationBindings({
    openviking: {
      async putOpenVikingCitation(record) {
        ovRows.set(`${record.workspaceId}:${record.citationId}`, record);
        return record;
      },
      async getOpenVikingCitation(workspaceId, citationId) {
        return ovRows.get(`${workspaceId}:${citationId}`) ?? null;
      },
    },
  });
  const reads = createOpenVikingMemoryReads({
    client: {
      async invoke(request) {
        calls.push(request);
        return results;
      },
    },
    citations,
  });
  return { reads, calls, ovRows };
}

test("find and read bind OpenViking citations through the injected client", async () => {
  const { reads, calls, ovRows } = harness({
    retrieval_mode: "bm25",
    results: [
      {
        uri: "viking://resources/docs/deploy.md",
        accountId: "acct-a",
        contentHash: "sha256:abc",
        matchedLevel: "L2",
        title: "Deploy rollback",
        excerpt: "skipped tests",
      },
    ],
  });
  const found = await reads.find({
    workspaceId: "ws-a",
    agentId: "mem-1",
    operationId: "find-1",
    query: "deploy",
  });
  expect(found.items[0]).toMatchObject({
    kind: OPENVIKING_CITATION_KIND,
    uri: "viking://resources/docs/deploy.md",
    matchedLevel: "L2",
  });
  expect(calls[0]).toEqual({
    workspaceId: "ws-a",
    agentId: "mem-1",
    operation: "find",
    body: { query: "deploy", limit: 10, retrieval_mode: "bm25" },
  });
  expect(ovRows.get("ws-a:ov:viking://resources/docs/deploy.md")?.boundOperationId).toBe("find-1");

  const reader = harness({
    uri: "viking://resources/docs/runbook.md",
    accountId: "acct-a",
    content: "on-call runbook",
    title: "Runbook",
  });
  const read = await reader.reads.read({
    workspaceId: "ws-a",
    agentId: "mem-1",
    operationId: "read-1",
    uri: "viking://resources/docs/runbook.md",
  });
  expect(read.citation.kind).toBe(OPENVIKING_CITATION_KIND);
  expect(read.content).toBe("on-call runbook");
  expect(reader.calls[0]).toEqual({
    workspaceId: "ws-a",
    agentId: "mem-1",
    operation: "read",
    query: { uri: "viking://resources/docs/runbook.md" },
  });
});

test("binds catalog find hits that use abstract, numeric level, and no content hash", async () => {
  const { reads } = harness({
    status: "ok",
    accountId: "acct-a",
    result: {
      retrieval_mode: "bm25",
      memories: [],
      resources: [
        {
          uri: "viking://resources/docs/caroline.md",
          abstract: "Caroline went to the group in May",
          level: 1,
        },
      ],
      skills: [],
    },
  });
  const found = await reads.find({
    workspaceId: "ws-a",
    agentId: "mem-1",
    operationId: "find-env",
    query: "Caroline",
  });
  expect(found.items[0]).toMatchObject({
    uri: "viking://resources/docs/caroline.md",
    matchedLevel: "L1",
    excerpt: "Caroline went to the group in May",
    accountId: "acct-a",
  });
  expect(found.items[0]?.contentHash).toMatch(/^sha256:/);
});

test("search_context disables query expansion and never issues an OpenViking write", async () => {
  const { reads, calls } = harness({ retrieval_mode: "bm25", results: [] });
  await reads.searchContext({
    workspaceId: "ws-a",
    agentId: "mem-1",
    operationId: "ctx-1",
    query: "deploy",
    tokenBudget: 1600,
  });
  expect(calls[0]).toEqual({
    workspaceId: "ws-a",
    agentId: "mem-1",
    operation: "search_context",
    body: { query: "deploy", limit: 10, query_expansion: "off", token_budget: 1600 },
  });
  expect(JSON.stringify(calls[0])).not.toContain("write");
  await expect(
    reads.find({
      workspaceId: "ws-a",
      agentId: "mem-1",
      operationId: "write-1",
      query: "x",
    }),
  ).resolves.toEqual({ items: [] });
});

test("find keeps a skill revision and drops episode, insight, and episodeInsight", async () => {
  const { reads, ovRows } = harness({
    accountId: "acct-a",
    retrieval_mode: "bm25",
    results: [
      {
        uri: "viking://skills/deploy/revisions/3",
        kind: "skill_revision",
        matchedLevel: "L1",
        excerpt: "rollback still runs the smoke",
      },
      {
        uri: "viking://memories/episodes/ep-1",
        kind: "episode",
        matchedLevel: "L1",
        excerpt: "old episode",
      },
      {
        uri: "viking://resources/docs/note.md",
        kind: "insight",
        matchedLevel: "L1",
        excerpt: "old insight",
      },
      {
        uri: "viking://skills/deploy/revisions/9",
        relation: "episodeInsight",
        matchedLevel: "L1",
        excerpt: "retired relation",
      },
    ],
  });
  const found = await reads.find({
    workspaceId: "ws-a",
    agentId: "mem-1",
    operationId: "find-q160",
    query: "deploy",
  });
  expect(found.items.map((item) => item.uri)).toEqual(["viking://skills/deploy/revisions/3"]);
  expect([...ovRows.keys()]).toEqual(["ws-a:ov:viking://skills/deploy/revisions/3"]);
});

test("read refuses an episode uri before the upstream read", async () => {
  const { reads, calls } = harness({ content: "should not be served" });
  await expect(
    reads.read({
      workspaceId: "ws-a",
      agentId: "mem-1",
      operationId: "read-ep",
      uri: "viking://memories/episodes/ep-1",
    }),
  ).rejects.toBeInstanceOf(RetiredFromMemoryDiscoveryError);
  expect(calls).toEqual([]);
});

test("read binds the real OpenViking content response envelope", async () => {
  const { reads } = harness({
    status: "ok",
    accountId: "acct-a",
    result: "The observatory opened in 2041.",
  });
  const result = await reads.read({
    workspaceId: "ws-a",
    agentId: "mem-1",
    operationId: "read-envelope",
    uri: "viking://resources/docs/observatory.md",
  });
  expect(result.content).toBe("The observatory opened in 2041.");
  expect(result.citation.accountId).toBe("acct-a");
  expect(result.citation.contentHash).toMatch(/^sha256:/);
});

test("BM25-only find refuses an older backend response without lexical provenance", async () => {
  const { reads, ovRows } = harness({ results: [] });
  await expect(
    reads.find({
      workspaceId: "ws",
      agentId: "memory",
      operationId: "bm25-check",
      query: "deploy",
    }),
  ).rejects.toThrow("bm25_backend_required");
  expect(ovRows.size).toBe(0);
});

test("find exposes served graph navigation and expand forwards the explicit hop", async () => {
  const uri = "viking://resources/causal/block.md";
  const { reads, calls } = harness({
    retrieval_mode: "bm25",
    accountId: "acct-a",
    chain_ref: "chain-a",
    step: 0,
    remaining_hops: 4,
    exhausted: false,
    resources: [
      {
        uri,
        excerpt: "deployment checkpoint",
        level: 2,
        metadata: {
          kind: "native_block",
          status: "recorded",
          source_ref: "native-block:rev:b1",
          relations: ["incoming", "outgoing", "forks"],
        },
      },
    ],
  });
  const found = await reads.find({
    workspaceId: "ws-a",
    agentId: "memory",
    operationId: "find-graph",
    query: "deployment",
  });
  expect(found.retrieval).toMatchObject({
    mode: "bm25",
    chainRef: "chain-a",
    nodes: [{ uri, kind: "native_block", relations: ["incoming", "outgoing", "forks"] }],
  });
  await reads.expand({
    workspaceId: "ws-a",
    agentId: "memory",
    operationId: "hop-1",
    chainRef: "chain-a",
    uri,
    relation: "outgoing",
    limit: 3,
  });
  expect(calls[1]).toEqual({
    workspaceId: "ws-a",
    agentId: "memory",
    operation: "expand",
    body: { operation_id: "hop-1", chain_ref: "chain-a", uri, relation: "outgoing", limit: 3 },
  });
  await expect(
    reads.expand({
      workspaceId: "ws-b",
      agentId: "memory",
      operationId: "unserved",
      chainRef: "chain-a",
      uri,
      relation: "outgoing",
    }),
  ).rejects.toThrow();
  expect(calls).toHaveLength(2);
});

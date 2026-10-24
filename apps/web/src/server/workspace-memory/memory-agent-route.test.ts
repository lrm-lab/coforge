import { expect, test } from "bun:test";
import {
  decodeOpenVikingAgentResponse,
  OPENVIKING_AGENT_PROTOCOL,
  OPENVIKING_CITATION_KIND,
  workspaceProfileToToolFence,
} from "@lrm/coforge-sdk/agent";
import type {
  MemoryOfferRecord,
  OpenVikingCitationRecord,
} from "#src/server/db/repositories/workspace-memory-citation.repositories.server";
import { createMemoryCitationBindings } from "./memory-citations";
import { createMemoryAgentBudgetLedger } from "./memory-agent-budget";
import { createMemoryOffers } from "./memory-offers";
import { createOpenVikingMemoryReads } from "#src/server/openviking/openviking-memory-reads";
import { createMemoryAgentCommands } from "./memory-agent-route";
import { clearNoCardAllowance, hasNoCardAllowance } from "./no-card-allowance";

const ovHit = {
  uri: "viking://resources/docs/deploy.md",
  accountId: "acct-a",
  contentHash: "sha256:abc",
  matchedLevel: "L2",
  title: "Deploy rollback",
  excerpt: "skipped tests",
};

function commands(
  extras: {
    backendFailure?: Error;
    offerTargets?: {
      resolve: () => Promise<{ conversationId: string; targetAgentId: string } | null>;
    };
  } = {},
) {
  const ovRows = new Map<string, OpenVikingCitationRecord>();
  const offerRows = new Map<string, MemoryOfferRecord>();
  const gatewayCalls: Array<{ operation: string }> = [];
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
  const offers = createMemoryOffers({
    citations,
    offers: {
      async getOffer(workspaceId, operationId) {
        return offerRows.get(`${workspaceId}:${operationId}`) ?? null;
      },
      async putOffer(input) {
        offerRows.set(`${input.workspaceId}:${input.operationId}`, input);
        return { outcome: "saved" as const, offer: input };
      },
    },
    publisher: {
      async publish() {
        return { messageId: "offer-msg" };
      },
    },
    hints: {
      async prepare() {
        return { hint_id: "test-hint", tool: "memory_disposition" as const };
      },
    },
    channels: {
      async isMemoryAgent() {
        return false;
      },
      async isActiveChannelAgent() {
        return true;
      },
    },
  });
  const handler = createMemoryAgentCommands({
    fence: {
      async resolve() {
        return workspaceProfileToToolFence("openviking");
      },
    },
    directory: {
      async isDesignated() {
        return true;
      },
    },
    budgets: createMemoryAgentBudgetLedger(),
    citations,
    offers,
    openviking: createOpenVikingMemoryReads({
      client: {
        async invoke(request) {
          gatewayCalls.push({ operation: request.operation });
          if (extras.backendFailure) throw extras.backendFailure;
          return { retrieval_mode: "bm25", results: [ovHit] };
        },
      },
      citations,
    }),
    ...(extras.offerTargets ? { offerTargets: extras.offerTargets } : {}),
  });
  return { handler, offerRows, gatewayCalls };
}

test("forged citations cannot become an Offer", async () => {
  const { handler } = commands();
  const result = await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
    command: {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "offer",
      operationId: "offer-forged",
      conversationId: "ch-1",
      targetAgentId: "helper-1",
      recipientRationale: "guess",
      citationRefs: ["forged"],
      body: "no",
    },
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  expect(result.code).toContain("citation-ungrounded");
});

test("openviking answers preserve the citation kind on the Offer record", async () => {
  const { handler, offerRows } = commands();
  await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
    command: {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "fork_find",
      operationId: "find-1",
      query: "deploy",
    },
  });
  const offered = await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
    command: {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "offer",
      operationId: "offer-1",
      conversationId: "ch-1",
      targetAgentId: "helper-1",
      recipientRationale: "owns the task",
      citationRefs: ["ov:viking://resources/docs/deploy.md"],
      body: "cited evidence",
    },
  });
  expect(offered.ok).toBe(true);
  if (!offered.ok) throw new Error("expected offer");
  if (offered.response.op !== "offer") throw new Error("expected offer op");
  expect(offered.response.citations).toEqual([
    expect.objectContaining({
      kind: OPENVIKING_CITATION_KIND,
      citationId: "ov:viking://resources/docs/deploy.md",
    }),
  ]);
  expect(decodeOpenVikingAgentResponse("offer", offered.response)).toMatchObject({
    op: "offer",
    citations: [expect.objectContaining({ citationId: "ov:viking://resources/docs/deploy.md" })],
  });
  expect(offerRows.get("ws-a:offer-1")?.citations).toEqual([
    { kind: OPENVIKING_CITATION_KIND, citationId: "ov:viking://resources/docs/deploy.md" },
  ]);
});

test("the openviking profile allows repeated reads and enforces the Offer budget", async () => {
  const ov = commands();
  for (let index = 0; index < 20; index++) {
    const read = await ov.handler.handle({
      workspaceId: "ws-a",
      agentId: "mem-1",
      triggerMessageId: "msg-ov",
      command: {
        protocol: OPENVIKING_AGENT_PROTOCOL,
        op: "fork_find",
        operationId: `find-${index}`,
        query: "deploy",
      },
    });
    expect(read.ok).toBe(true);
  }
  expect(ov.gatewayCalls).toHaveLength(20);

  const offer = {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "offer" as const,
    conversationId: "ch-1",
    targetAgentId: "helper-1",
    recipientRationale: "owns the task",
    citationRefs: ["ov:viking://resources/docs/deploy.md"],
    body: "cited",
  };
  const firstOffer = await ov.handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-ov",
    command: { ...offer, operationId: "offer-1" },
  });
  expect(firstOffer.ok).toBe(true);
  const secondOffer = await ov.handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-ov",
    command: { ...offer, operationId: "offer-2" },
  });
  expect(secondOffer.ok).toBe(false);
  if (secondOffer.ok) throw new Error("expected offer budget failure");
  expect(secondOffer.code).toBe("openviking-budget-exhausted");
});

test("Memory Agent citation paths never write OpenViking", async () => {
  const { handler, gatewayCalls } = commands();
  await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
    command: {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "fork_find",
      operationId: "find-1",
      query: "deploy",
    },
  });
  expect(gatewayCalls.every((call) => call.operation === "fork_find")).toBe(true);
});

test("foreign protocol commands are rejected as invalid", async () => {
  const { handler } = commands();
  const result = await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
    command: {
      protocol: "coforge.causal.agent.v1",
      op: "search",
      operationId: "search-1",
      query: "deploy",
    },
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected invalid");
  expect(result.code).toBe("openviking-request-invalid");
});

test("an offer omits channel ids and the server binds the unanswered @memory target", async () => {
  const { handler, offerRows } = commands({
    offerTargets: {
      async resolve() {
        return { conversationId: "ch-bound", targetAgentId: "task-1" };
      },
    },
  });
  await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
    command: {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "fork_find",
      operationId: "find-1",
      query: "deploy",
    },
  });
  const offered = await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-2",
    command: {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "offer",
      operationId: "offer-bound",
      citationRefs: ["ov:viking://resources/docs/deploy.md"],
      body: "cited from an earlier retrieval",
    },
  });
  expect(offered.ok).toBe(true);
  expect(offerRows.get("ws-a:offer-bound")).toMatchObject({
    conversationId: "ch-bound",
    recipientAgentId: "task-1",
    recipientRationale: "answers the explicit @memory question",
  });
});

test("an offer without channel ids fails when no @memory target is bound", async () => {
  const { handler } = commands();
  const offered = await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
    command: {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "offer",
      operationId: "offer-unbound",
      citationRefs: ["ov:viking://resources/docs/deploy.md"],
      body: "cited",
    },
  });
  expect(offered.ok).toBe(false);
  if (offered.ok) throw new Error("expected unresolved target");
  expect(offered.message).toContain("unresolved");
});

test("an offer replay with the same operationId skips the per-trigger budget", async () => {
  const { handler } = commands();
  await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
    command: {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "fork_find",
      operationId: "find-r",
      query: "deploy",
    },
  });
  const offerCommand = {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "offer",
    operationId: "offer-replay-1",
    conversationId: "ch-1",
    targetAgentId: "helper-1",
    recipientRationale: "owns the task",
    citationRefs: ["ov:viking://resources/docs/deploy.md"],
    body: "cited evidence",
  };
  const first = await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
    command: offerCommand,
  });
  expect(first.ok).toBe(true);

  // Same operationId on a LATER trigger message: idempotent replay must not
  // consume that trigger's budget — the model re-answers answered questions
  // with topic-derived operationIds and a budget rejection stalls the turn.
  const second = await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-2",
    command: { ...offerCommand, body: "refined but same operationId" },
  });
  expect(second.ok).toBe(true);
  if (!second.ok) throw new Error("expected replay");
  expect(second.response.duplicate).toBe(true);

  // The replay consumed nothing: a fresh offer on msg-2 still passes budget.
  const third = await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-2",
    command: { ...offerCommand, operationId: "offer-fresh-1" },
  });
  expect(third.ok).toBe(true);
});

test("the same trigger can retrieve more than three times through the Memory route", async () => {
  const { handler, gatewayCalls } = commands();
  for (let index = 0; index < 20; index++) {
    const result = await handler.handle({
      workspaceId: "ws-a",
      agentId: "mem-1",
      triggerMessageId: "msg-1",
      command: {
        protocol: OPENVIKING_AGENT_PROTOCOL,
        op: "fork_find",
        operationId: `find-${index}`,
        query: "deploy",
      },
    });
    expect(result.ok).toBe(true);
  }
  expect(gatewayCalls).toHaveLength(20);
});

test("a valid retrieval experiencing backend failure is not blamed on model arguments", async () => {
  const { handler } = commands({ backendFailure: new Error("private runtime credential failed") });
  const result = await handler.handle({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
    command: {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "fork_find",
      operationId: "backend-failure",
      query: "deploy",
    },
  });
  expect(result).toMatchObject({ ok: false, status: 503, code: "openviking-runtime-unavailable" });
  expect(JSON.stringify(result)).not.toContain("private runtime credential");
});

test("an empty retrieval grants the no-card allowance; a retrieval with hits or an Offer clears it", async () => {
  const { handler } = commands();
  const base = { workspaceId: "ws-nc", agentId: "mem-nc", triggerMessageId: "msg-1" };
  clearNoCardAllowance("ws-nc", "mem-nc");
  // The test gateway returns no experience cards, only a document hit for the other finds.
  const empty = await handler.handle({
    ...base,
    command: {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "experience_find",
      operationId: "exp-empty",
      query: "contract",
    },
  });
  expect(empty.ok).toBe(true);
  expect(hasNoCardAllowance("ws-nc", "mem-nc")).toBe(true);
  expect(hasNoCardAllowance("ws-nc", "someone-else")).toBe(false);

  const hit = await handler.handle({
    ...base,
    command: {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "fork_find",
      operationId: "fork-hit",
      query: "deploy",
    },
  });
  expect(hit.ok).toBe(true);
  expect(hasNoCardAllowance("ws-nc", "mem-nc")).toBe(false);
});

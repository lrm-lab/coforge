import { expect, test } from "bun:test";
import { OPENVIKING_CITATION_KIND, type OpenVikingCitation } from "./memory-citations";
import {
  type OpenVikingExpandCommand,
  type OpenVikingForkFindResponse,
  type OpenVikingRetrieval,
  MEMORY_OFFER_BUDGET_PER_TRIGGER,
  OPENVIKING_AGENT_ERROR_CODES,
  OPENVIKING_AGENT_OPERATIONS,
  OPENVIKING_AGENT_PROTOCOL,
  OPENVIKING_ARGUMENT_EXAMPLES,
  OPENVIKING_CANDIDATE_LIMIT_MAX,
  OPENVIKING_OPERATION_ID_RULE,
  OPENVIKING_TOOL_NAMES,
  OPENVIKING_TOOL_PROFILE,
  decodeOpenVikingAgentCommand,
  decodeOpenVikingAgentResponse,
  isOpenVikingAgentError,
  isOpenVikingOperationId,
} from "./openviking-memory";

const citation: OpenVikingCitation = {
  kind: OPENVIKING_CITATION_KIND,
  citationId: "ov:wiki/deploy",
  workspaceId: "workspace-1",
  accountId: "ov-account-1",
  uri: "viking://workspace-1/docs/deploy.md",
  contentHash: "sha256:abc",
  matchedLevel: "L2",
  title: "Deploy rollback",
};

test("freezes the OpenViking agent protocol, fence, tools, and turn budget", () => {
  expect(OPENVIKING_AGENT_PROTOCOL).toBe("coforge.openviking.agent.v1");
  expect(OPENVIKING_TOOL_PROFILE).toBe("openviking-memory");
  expect(OPENVIKING_TOOL_NAMES).toEqual({
    forkFind: "ov_fork_find",
    experienceFind: "ov_experience_find",
    searchContext: "ov_search_context",
    read: "ov_read",
    expand: "ov_expand",
    offer: "memory_offer",
    diagnose: "memory_diagnose",
  });
  expect(OPENVIKING_AGENT_OPERATIONS).toEqual([
    "fork_find",
    "experience_find",
    "search_context",
    "read",
    "expand",
    "offer",
    "diagnose",
  ]);

  expect(MEMORY_OFFER_BUDGET_PER_TRIGGER).toBe(1);
  expect(OPENVIKING_CANDIDATE_LIMIT_MAX).toBe(10);
});

test("accepts a stable operation id and rejects questions or spaces", () => {
  expect(isOpenVikingOperationId("deploy-runbook")).toBe(true);
  expect(isOpenVikingOperationId("A")).toBe(true);
  expect(isOpenVikingOperationId("why did we skip tests?")).toBe(false);
  expect(isOpenVikingOperationId("has space")).toBe(false);
  expect(isOpenVikingOperationId("")).toBe(false);
});

test("decodes read-only OpenViking commands without tenant credentials", () => {
  const find = decodeOpenVikingAgentCommand({
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "fork_find",
    operationId: "deploy-runbook",
    query: "deploy rollback",
    limit: 5,
  });
  expect(find).toEqual({
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "fork_find",
    operationId: "deploy-runbook",
    query: "deploy rollback",
    limit: 5,
  });
  expect(
    decodeOpenVikingAgentCommand({
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "search_context",
      operationId: "deploy-context",
      query: "why did the deploy roll back",
      tokenBudget: 2400,
    }).op,
  ).toBe("search_context");
  expect(
    decodeOpenVikingAgentCommand({
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "read",
      operationId: "read-deploy",
      uri: "viking://workspace-1/docs/deploy.md",
    }).op,
  ).toBe("read");
  expect(JSON.stringify(find)).not.toContain("Bearer");
  expect(JSON.stringify(find)).not.toContain("tenantToken");
  expect(JSON.stringify(find)).not.toContain("apiKey");
});

test("accepts a numeric string limit inside the candidate cap", () => {
  expect(
    decodeOpenVikingAgentCommand({
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "fork_find",
      operationId: "string-limit",
      query: "deploy",
      limit: "5",
    }),
  ).toMatchObject({ op: "fork_find", limit: 5 });
  expect(() =>
    decodeOpenVikingAgentCommand({
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "fork_find",
      operationId: "string-limit",
      query: "deploy",
      limit: "11",
    }),
  ).toThrow("invalid openviking fork_find limit");
});

test("experience_find validates the ADR-0046 slot vocabularies", () => {
  const base = {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "experience_find",
    operationId: "exp-1",
    query: "pdf report missing sections",
  };
  expect(
    decodeOpenVikingAgentCommand({
      ...base,
      deliverable: "pdf",
      issueKind: "missing_section",
      kind: "skill_card",
      occupation: "Financial Analyst",
      limit: "3",
    }),
  ).toMatchObject({ op: "experience_find", deliverable: "pdf", limit: 3 });
  expect(() => decodeOpenVikingAgentCommand({ ...base, deliverable: "zip" })).toThrow(
    "invalid openviking experience_find deliverable",
  );
  expect(() => decodeOpenVikingAgentCommand({ ...base, issueKind: "slow" })).toThrow(
    "invalid openviking experience_find issueKind",
  );
  expect(() => decodeOpenVikingAgentCommand({ ...base, targetUri: "viking://x" })).toThrow(
    "fixed namespace",
  );
  expect(
    decodeOpenVikingAgentResponse("experience_find", {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "experience_find",
      operationId: "exp-1",
      duplicate: false,
      items: [],
      relaxed: true,
    }),
  ).toMatchObject({ relaxed: true });
  expect(() =>
    decodeOpenVikingAgentResponse("experience_find", {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "experience_find",
      operationId: "exp-1",
      duplicate: false,
      items: [],
    }),
  ).toThrow("relaxed");
});

test("rejects credential fields and candidate limits above ten", () => {
  expect(() =>
    decodeOpenVikingAgentCommand({
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "fork_find",
      operationId: "too-many",
      query: "deploy",
      limit: 11,
    }),
  ).toThrow("invalid openviking fork_find limit");
  expect(() =>
    decodeOpenVikingAgentCommand({
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "search_context",
      operationId: "bad-budget",
      query: "deploy",
      tokenBudget: 0,
    }),
  ).toThrow("invalid openviking search_context tokenBudget");
  const decoded = decodeOpenVikingAgentCommand({
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "fork_find",
    operationId: "ok-1",
    query: "deploy",
    tenantToken: "secret",
    apiKey: "ov-key",
  });
  expect("tenantToken" in decoded).toBe(false);
  expect("apiKey" in decoded).toBe(false);
});

test("accepts citationRefs sent as a JSON string", () => {
  expect(
    decodeOpenVikingAgentCommand({
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "offer",
      operationId: "offer-string-refs",
      citationRefs: '["ov:wiki/deploy"]',
      body: "the last skip-tests deploy rolled back",
    }),
  ).toMatchObject({ citationRefs: ["ov:wiki/deploy"] });
});

test("an offer may omit the channel and recipient for the server to bind", () => {
  expect(
    decodeOpenVikingAgentCommand({
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "offer",
      operationId: "offer-1",
      citationRefs: ["ov:wiki/deploy"],
      body: "the last skip-tests deploy rolled back",
    }),
  ).toEqual({
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "offer",
    operationId: "offer-1",
    citationRefs: ["ov:wiki/deploy"],
    body: "the last skip-tests deploy rolled back",
  });
});

test("empty arguments name the missing fields, a copyable example, and the operationId rule", () => {
  let message = "";
  try {
    decodeOpenVikingAgentCommand({ protocol: OPENVIKING_AGENT_PROTOCOL, op: "fork_find" });
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  expect(message).toContain("missing operationId, query");
  expect(message).toContain(OPENVIKING_ARGUMENT_EXAMPLES.fork_find);
  expect(message).toContain(OPENVIKING_OPERATION_ID_RULE);
  expect(message).toContain("^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$");
});

test("an offer missing citationRefs names that field and shows an example", () => {
  let message = "";
  try {
    decodeOpenVikingAgentCommand({
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "offer",
      operationId: "offer-1",
      body: "the last deploy rolled back",
    });
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  expect(message).toContain("missing citationRefs");
  expect(message).not.toContain("missing body");
  expect(message).not.toContain("missing operationId");
  expect(message).toContain(OPENVIKING_ARGUMENT_EXAMPLES.offer);
  expect(message).toContain(OPENVIKING_OPERATION_ID_RULE);
});

test("rejects a malformed command before it can cross the proxy", () => {
  expect(() =>
    decodeOpenVikingAgentCommand({
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "fork_find",
      operationId: "not a key",
      query: "x",
    }),
  ).toThrow("invalid openviking operationId");
  expect(() =>
    decodeOpenVikingAgentCommand({
      protocol: "other",
      op: "fork_find",
      operationId: "ok-1",
      query: "x",
    }),
  ).toThrow("invalid openviking protocol");
  expect(() =>
    decodeOpenVikingAgentCommand({
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "write",
      operationId: "ok-1",
      query: "x",
    }),
  ).toThrow("invalid openviking operation");
});

test("decodes cited find, context, read, and offer responses", () => {
  expect(
    decodeOpenVikingAgentResponse("fork_find", {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "fork_find",
      operationId: "deploy-runbook",
      duplicate: false,
      items: [citation],
    }),
  ).toEqual({
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "fork_find",
    operationId: "deploy-runbook",
    duplicate: false,
    items: [citation],
  });
  expect(
    decodeOpenVikingAgentResponse("read", {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "read",
      operationId: "read-deploy",
      duplicate: false,
      citation,
      content: "the last skip-tests deploy rolled back",
    }).op,
  ).toBe("read");
  const offer = decodeOpenVikingAgentResponse("offer", {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "offer",
    operationId: "offer-1",
    published: true,
    duplicate: false,
    messageId: "msg-1",
    recipientAgentId: "agent-2",
    citations: [citation],
  });
  expect(offer.op).toBe("offer");
  expect(offer).toMatchObject({ published: true });
});

test("fail-closes mixed or unversioned citations on an OpenViking response", () => {
  expect(() =>
    decodeOpenVikingAgentResponse("fork_find", {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "fork_find",
      operationId: "ok-1",
      duplicate: false,
      items: [
        {
          kind: "causal_memory",
          citationId: "cm:decision-1",
          causalItemId: "decision-1",
          factVersion: 1,
          admittedSegmentId: "segment-1",
          sourceMessageIds: ["11111111-1111-1111-1111-111111111111"],
          displayContent: "not an openviking citation",
        },
      ],
    }),
  ).toThrow("invalid memory citation kind");
  expect(() =>
    decodeOpenVikingAgentResponse("fork_find", {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "fork_find",
      operationId: "ok-1",
      duplicate: false,
      items: [
        {
          kind: OPENVIKING_CITATION_KIND,
          citationId: "ov:wiki/deploy",
          workspaceId: "workspace-1",
          accountId: "ov-account-1",
          uri: "viking://workspace-1/docs/deploy.md",
          matchedLevel: "L2",
          title: "unversioned",
        },
      ],
    }),
  ).toThrow("unversioned openviking citation");
  expect(() =>
    decodeOpenVikingAgentResponse("fork_find", {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "fork_find",
      operationId: "ok-1",
      duplicate: false,
      items: Array.from({ length: 11 }, (_, index) => ({
        ...citation,
        citationId: `ov:item-${index}`,
      })),
    }),
  ).toThrow("openviking candidate limit exceeded");
});

test("keeps agent errors sanitized and enumerated", () => {
  expect(OPENVIKING_AGENT_ERROR_CODES).toContain("openviking-citation-ungrounded");
  expect(
    isOpenVikingAgentError({
      protocol: OPENVIKING_AGENT_PROTOCOL,
      operationId: "offer-1",
      error: { code: "openviking-citation-ungrounded", message: "citation was not served" },
    }),
  ).toBe(true);
  expect(
    isOpenVikingAgentError({
      protocol: OPENVIKING_AGENT_PROTOCOL,
      error: { code: "internal-db", message: "password=secret" },
    }),
  ).toBe(false);
});

test("diagnosis commands bind to a real message UUID and reject false successful status", () => {
  const command = {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "diagnose" as const,
    operationId: "diagnose-1",
    messageId: "00000000-0000-4000-8000-000000000001",
  };
  expect(decodeOpenVikingAgentCommand(command)).toEqual(command);
  expect(() =>
    decodeOpenVikingAgentCommand({ ...command, messageId: "------------------------------------" }),
  ).toThrow();
  expect(decodeOpenVikingAgentCommand({ ...command, tenantToken: "secret" })).not.toHaveProperty(
    "tenantToken",
  );
  expect(() =>
    decodeOpenVikingAgentResponse("diagnose", {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "diagnose",
      operationId: "diagnose-1",
      duplicate: false,
      status: "running",
      published: true,
    }),
  ).toThrow();
});

test("decodes a graph hop from the BM25 discovery chain", () => {
  const command: OpenVikingExpandCommand = {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "expand",
    operationId: "hop-1",
    chainRef: "chain-1",
    uri: "viking://resources/causal/fork.md",
    relation: "anchor",
    limit: 5,
  };
  expect(decodeOpenVikingAgentCommand(command)).toEqual(command);
  expect(() =>
    decodeOpenVikingAgentCommand({ ...command, relation: "arbitrary_private_read" }),
  ).toThrow();
});

test("BM25 discovery preserves the chain and typed graph navigation", () => {
  const retrieval: OpenVikingRetrieval = {
    mode: "bm25",
    chainRef: "chain-1",
    step: 0,
    remainingHops: 4,
    exhausted: false,
    nodes: [
      {
        uri: citation.uri,
        kind: "fork_overlay",
        status: "counterfactual",
        relations: ["anchor", "branch_steps"],
      },
    ],
  };
  const response: OpenVikingForkFindResponse = {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "fork_find",
    operationId: "find-graph",
    duplicate: false,
    items: [citation],
    retrieval,
  };
  expect(decodeOpenVikingAgentResponse("fork_find", response)).toEqual(response);
});

// An Offer may cite the union of several successful, individually bounded reads.
test("decodes published offers containing citations from three full reads", () => {
  const citations = Array.from({ length: 30 }, (_, index) => ({
    ...citation,
    citationId: `ov:item-${index}`,
  }));
  const response = decodeOpenVikingAgentResponse("offer", {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "offer",
    operationId: "offer-union",
    duplicate: false,
    published: true,
    messageId: "message-union",
    citations,
  });
  expect(response).toMatchObject({ published: true, citations });
  expect(() =>
    decodeOpenVikingAgentResponse("offer", {
      ...response,
      citations: [...citations, { ...citation, kind: "untrusted" }],
    }),
  ).toThrow("invalid memory citation kind");
});

test("fork lookup has no caller-controlled namespace and legacy document find is refused", () => {
  expect(
    decodeOpenVikingAgentCommand({
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "fork_find",
      operationId: "fork-new-1",
      query: "constraint verification",
    }),
  ).toMatchObject({ op: "fork_find" });
  expect(() =>
    decodeOpenVikingAgentCommand({
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "fork_find",
      operationId: "fork-escape",
      query: "facts",
      targetUri: "viking://resources/docs",
    }),
  ).toThrow();
  expect(() =>
    decodeOpenVikingAgentCommand({
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "find",
      operationId: "legacy-find",
      query: "facts",
    }),
  ).toThrow();
});

test("context budget matches native bounds", () => {
  for (const tokenBudget of [64, 32000])
    expect(
      decodeOpenVikingAgentCommand({
        protocol: OPENVIKING_AGENT_PROTOCOL,
        op: "search_context",
        operationId: "context-bounds",
        query: "facts",
        tokenBudget,
      }),
    ).toMatchObject({ tokenBudget });
  for (const tokenBudget of [63, 32001])
    expect(() =>
      decodeOpenVikingAgentCommand({
        protocol: OPENVIKING_AGENT_PROTOCOL,
        op: "search_context",
        operationId: "context-bounds",
        query: "facts",
        tokenBudget,
      }),
    ).toThrow("tokenBudget");
});

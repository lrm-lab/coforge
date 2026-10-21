import { expect, test } from "bun:test";
import {
  OPENVIKING_AGENT_PROTOCOL,
  OPENVIKING_TOOL_NAMES,
  OPENVIKING_TOOL_PROFILE,
  agentApiRoutes,
} from "@lrm/coforge-sdk/agent";
import {
  MemoryAgentTurnBudget,
  createMemoryFenceTools,
  resourceLoaderOptionsForSession,
  type MemoryAgentProxy,
} from "../src/runner";

const MUTATION_TOOL_NAMES = [
  "bash",
  "shell",
  "write",
  "edit",
  "apply_patch",
  "filesystem",
  "network",
];

const CHANNEL_MESSAGE_TOOLS = ["message_check", "message_read", "send_channel_message"] as const;

test("strict eval Memory exposes reads and server-owned controls but no ordinary send", () => {
  const tools = createMemoryFenceTools(
    OPENVIKING_TOOL_PROFILE,
    new MemoryAgentTurnBudget(),
    fakeProxy(),
    { memoryOfferOnly: true },
  );
  expect(tools.map((tool) => tool.name)).toEqual([
    "ov_fork_find",
    "ov_search_context",
    "ov_expand",
    "ov_read",
    "memory_offer",
    "memory_diagnose",
    "message_check",
    "message_read",
  ]);
});

function emptyItemsResponse(protocol: string, op: string, operationId: string) {
  return { protocol, op, operationId, duplicate: false, items: [] };
}

function fakeProxy(
  handler?: (path: string, body: unknown) => unknown,
): MemoryAgentProxy & { calls: Array<{ path: string; body: unknown }> } {
  const calls: Array<{ path: string; body: unknown }> = [];
  return {
    calls,
    async post(path, body) {
      calls.push({ path, body });
      if (handler) return handler(path, body);
      const command = body as { protocol?: string; op?: string; operationId?: string };
      return emptyItemsResponse(
        command.protocol ?? "",
        command.op ?? "",
        command.operationId ?? "ok-1",
      );
    },
  };
}

async function executeTool(
  tools: ReturnType<typeof createMemoryFenceTools>,
  name: string,
  params: Record<string, unknown>,
) {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.execute(name, params, undefined, undefined, undefined as never);
}

test("Memory Agent sessions disable Pi skill, context, and extension injection", () => {
  expect(resourceLoaderOptionsForSession({ instructions: "stand", memoryFence: false })).toEqual({
    systemPromptOverride: expect.any(Function),
  });
  expect(resourceLoaderOptionsForSession({ instructions: "stand", memoryFence: true })).toEqual({
    systemPromptOverride: expect.any(Function),
    noSkills: true,
    noContextFiles: true,
    noExtensions: true,
  });
  expect(
    resourceLoaderOptionsForSession({ instructions: "stand", disableHostPiInjection: true }),
  ).toEqual({
    systemPromptOverride: expect.any(Function),
    noSkills: true,
    noContextFiles: true,
    noExtensions: true,
  });
});

test("the openviking-memory fence exposes reads, scoped diagnosis, offers, and channel message tools", () => {
  const names = createMemoryFenceTools(OPENVIKING_TOOL_PROFILE, new MemoryAgentTurnBudget()).map(
    (tool) => tool.name,
  );
  expect(names).toEqual([
    OPENVIKING_TOOL_NAMES.forkFind,
    OPENVIKING_TOOL_NAMES.searchContext,
    OPENVIKING_TOOL_NAMES.expand,
    OPENVIKING_TOOL_NAMES.read,
    OPENVIKING_TOOL_NAMES.offer,
    OPENVIKING_TOOL_NAMES.diagnose,
    ...CHANNEL_MESSAGE_TOOLS,
  ]);
  expect(names.some((name) => name.startsWith("causal_"))).toBe(false);
  expect(MUTATION_TOOL_NAMES.some((name) => names.includes(name))).toBe(false);
});

test("native memory tools forward more than three reads in one trigger", async () => {
  const proxy = fakeProxy();
  const budget = new MemoryAgentTurnBudget();
  const tools = createMemoryFenceTools(OPENVIKING_TOOL_PROFILE, budget, proxy);
  for (let index = 0; index < 20; index++) {
    await executeTool(tools, OPENVIKING_TOOL_NAMES.forkFind, {
      operationId: `find-${index}`,
      query: "deploy rollback",
      limit: 10,
    });
  }
  expect(proxy.calls).toHaveLength(20);
  expect(budget.snapshot()).toEqual({ reads: 20, offers: 0 });
});

test("a second Memory Offer is rejected", () => {
  const budget = new MemoryAgentTurnBudget();
  const offer = {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "offer" as const,
    operationId: "o1",
    conversationId: "c",
    targetAgentId: "a",
    recipientRationale: "owns the task",
    citationRefs: ["ov:wiki/deploy"],
    body: "cited offer",
  };
  budget.consume(offer);
  expect(() => budget.consume({ ...offer, operationId: "o2" })).toThrow("offer budget");
});

test("the factory rejects a candidate limit above ten before calling the proxy", async () => {
  const proxy = fakeProxy();
  const tools = createMemoryFenceTools(OPENVIKING_TOOL_PROFILE, new MemoryAgentTurnBudget(), proxy);
  await expect(
    executeTool(tools, OPENVIKING_TOOL_NAMES.forkFind, {
      operationId: "too-many",
      query: "deploy",
      limit: 11,
    }),
  ).rejects.toThrow("invalid openviking fork_find limit");
  expect(proxy.calls).toEqual([]);
});

test("reset restores reads and offers for the next triggering message", () => {
  const budget = new MemoryAgentTurnBudget();
  const find = {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "fork_find" as const,
    operationId: "f1",
    query: "deploy",
  };
  const offer = {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "offer" as const,
    operationId: "o1",
    conversationId: "c",
    targetAgentId: "a",
    recipientRationale: "owns the task",
    citationRefs: ["ov:wiki/deploy"],
    body: "cited offer",
  };
  budget.consume(find);
  budget.consume(offer);
  expect(budget.snapshot()).toEqual({ reads: 1, offers: 1 });
  budget.reset();
  expect(budget.snapshot()).toEqual({ reads: 0, offers: 0 });
  budget.consume({ ...find, operationId: "f2" });
  budget.consume({ ...offer, operationId: "o2" });
});

test("ov_* tools post the frozen openviking proxy path and never a mutation verb", async () => {
  const proxy = fakeProxy();
  const tools = createMemoryFenceTools(OPENVIKING_TOOL_PROFILE, new MemoryAgentTurnBudget(), proxy);
  await executeTool(tools, OPENVIKING_TOOL_NAMES.forkFind, {
    operationId: "find-1",
    query: "deploy rollback",
    limit: 10,
  });
  expect(proxy.calls).toEqual([
    {
      path: agentApiRoutes.proxy.openviking.path,
      body: {
        protocol: OPENVIKING_AGENT_PROTOCOL,
        op: "fork_find",
        operationId: "find-1",
        query: "deploy rollback",
        limit: 10,
      },
    },
  ]);
  expect(JSON.stringify(proxy.calls[0]?.body)).not.toContain("write");
  expect(JSON.stringify(proxy.calls[0]?.body)).not.toContain("commit");
});

test("openviking-memory search_context reads are counted without a per-trigger cap", () => {
  const budget = new MemoryAgentTurnBudget();
  const searchContext = {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "search_context" as const,
    operationId: "c1",
    query: "deploy",
    tokenBudget: 8000,
  };
  budget.consume(searchContext);
  expect(budget.snapshot()).toEqual({ reads: 1, offers: 0 });
  budget.consume({ ...searchContext, operationId: "c2" });
  budget.consume({ ...searchContext, operationId: "c3" });
  expect(() => budget.consume({ ...searchContext, operationId: "c4" })).not.toThrow();
  expect(budget.snapshot()).toEqual({ reads: 4, offers: 0 });
});

test("empty ov_fork_find arguments return an example error and do not spend the read budget", async () => {
  const budget = new MemoryAgentTurnBudget();
  const proxy = fakeProxy();
  const tools = createMemoryFenceTools(OPENVIKING_TOOL_PROFILE, budget, proxy);
  const find = tools.find((tool) => tool.name === OPENVIKING_TOOL_NAMES.forkFind);
  expect(typeof find?.prepareArguments).toBe("function");
  expect(() => find?.prepareArguments?.({})).toThrow(/missing operationId, query/);
  expect(() => find?.prepareArguments?.({})).toThrow(/\{"operationId": "find-1"/);
  await expect(executeTool(tools, OPENVIKING_TOOL_NAMES.forkFind, {})).rejects.toThrow(
    /missing operationId, query/,
  );
  expect(budget.snapshot()).toEqual({ reads: 0, offers: 0 });
  expect(proxy.calls).toEqual([]);
  const described = find?.parameters as { properties?: Record<string, { description?: string }> };
  expect(described.properties?.operationId?.description).toContain("find-1");
  expect(find?.description).toContain("不能空对象");
});

test("send_channel_message accepts message only as an alias of a missing content", async () => {
  const proxy = fakeProxy(() => ({ accepted: true }));
  const tools = createMemoryFenceTools(OPENVIKING_TOOL_PROFILE, new MemoryAgentTurnBudget(), proxy);
  const send = tools.find((tool) => tool.name === "send_channel_message");
  expect(send?.prepareArguments?.({ target: "#general", message: "hello" })).toEqual({
    target: "#general",
    content: "hello",
  });
  expect(
    send?.prepareArguments?.({ target: "#general", content: "kept", message: "ignored" }),
  ).toEqual({ target: "#general", content: "kept" });
  expect(() => send?.prepareArguments?.({})).toThrow(/The body field name is content, not message/);
  await executeTool(tools, "send_channel_message", { target: "#general", message: "from-alias" });
  expect(proxy.calls[0]?.body).toMatchObject({
    operation: "send",
    target: "#general",
    content: "from-alias",
  });
  expect(proxy.calls[0]?.body).not.toHaveProperty("message");
});

test("Memory exposes context search through its read-only fence", () => {
  const tools = createMemoryFenceTools(
    OPENVIKING_TOOL_PROFILE,
    new MemoryAgentTurnBudget(),
    fakeProxy(),
  );
  expect(tools.some((tool) => tool.name === "ov_search_context")).toBe(true);
});

test("group Memory tools default to their own channel and reject another channel", async () => {
  const proxy = fakeProxy();
  const tools = createMemoryFenceTools(
    OPENVIKING_TOOL_PROFILE,
    new MemoryAgentTurnBudget(),
    proxy,
    { conversation: { conversationId: "group-alpha", target: "#alpha" } },
  );
  await executeTool(tools, "message_check", {});
  expect(proxy.calls[0]!.body).toMatchObject({ operation: "check", target: "#alpha" });
  await executeTool(tools, "message_check", { target: "#alpha:root" });
  expect(proxy.calls[1]!.body).toMatchObject({ target: "#alpha:root" });
  await expect(executeTool(tools, "message_read", { target: "#beta" })).rejects.toThrow(
    "this conversation",
  );
  expect(proxy.calls).toHaveLength(2);
});

test("Memory control session exposes no tools that could consume another group's inbox", () => {
  expect(
    createMemoryFenceTools(OPENVIKING_TOOL_PROFILE, new MemoryAgentTurnBudget(), fakeProxy(), {
      controlSession: true,
    }),
  ).toEqual([]);
});

test("native diagnosis forwards the request without consuming retrieval budget", async () => {
  const budget = new MemoryAgentTurnBudget();
  const posts: unknown[] = [];
  const tool = createMemoryFenceTools(OPENVIKING_TOOL_PROFILE, budget, {
    async post(path, body) {
      posts.push({ path, body });
      return {
        protocol: OPENVIKING_AGENT_PROTOCOL,
        op: "diagnose",
        operationId: "diagnose-1",
        duplicate: false,
        status: "completed",
        published: true,
        messageId: "answer",
      };
    },
  }).find((tool) => tool.name === "memory_diagnose")!;
  const args = { operationId: "diagnose-1", messageId: "00000000-0000-4000-8000-000000000001" };
  const result = await tool.execute("call", args, undefined, undefined, {} as never);
  expect(posts).toEqual([
    {
      path: agentApiRoutes.proxy.openviking.path,
      body: { protocol: OPENVIKING_AGENT_PROTOCOL, op: "diagnose", ...args },
    },
  ]);
  expect(result.content).toEqual([
    {
      type: "text",
      text: JSON.stringify({
        protocol: OPENVIKING_AGENT_PROTOCOL,
        op: "diagnose",
        operationId: "diagnose-1",
        duplicate: false,
        status: "completed",
        published: true,
        messageId: "answer",
      }),
    },
  ]);
  expect(budget.snapshot()).toEqual({ reads: 0, offers: 0 });
});

test("unchanged retrieval nudges a partial Offer without blocking further reads", async () => {
  const proxy = fakeProxy((_path, raw) => {
    const command = raw as { protocol: string; op: string; operationId: string; query: string };
    return {
      ...emptyItemsResponse(command.protocol, command.op, command.operationId),
      items: [
        {
          kind: "openviking",
          citationId: command.query === "new evidence" ? "ov:new" : "ov:known",
          workspaceId: "ws",
          accountId: "acct",
          uri: "viking://resources/doc.md",
          contentHash: "sha256:fixture",
          matchedLevel: "L2",
          excerpt: "Source evidence.",
        },
      ],
    };
  });
  const tools = createMemoryFenceTools(OPENVIKING_TOOL_PROFILE, new MemoryAgentTurnBudget(), proxy);
  let result: Awaited<ReturnType<typeof executeTool>>;
  for (let index = 0; index < 3; index++) {
    result = await executeTool(tools, OPENVIKING_TOOL_NAMES.forkFind, {
      operationId: `find-${index}`,
      query: "same evidence",
    });
  }
  expect(
    result!.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n"),
  ).toContain("partial cited memory_offer");
  expect(
    result!.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n"),
  ).toContain("ov:known");
  const fresh = await executeTool(tools, OPENVIKING_TOOL_NAMES.forkFind, {
    operationId: "find-fresh",
    query: "new evidence",
  });
  expect(
    fresh.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n"),
  ).not.toContain("No new evidence");
  expect(proxy.calls).toHaveLength(4);
});

test("a new trigger cannot silently replay an old Offer with a different body", () => {
  const budget = new MemoryAgentTurnBudget();
  budget.consume({
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "offer",
    operationId: "progress-1",
    body: "First partial finding",
    citationRefs: ["ov:known"],
  });
  budget.reset();
  expect(() =>
    budget.consume({
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "offer",
      operationId: "progress-1",
      body: "New findings after the follow-up",
      citationRefs: ["ov:known"],
    }),
  ).toThrow("operationId already used for a different Offer");
  expect(budget.snapshot().offers).toBe(0);
  expect(() =>
    budget.consume({
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "offer",
      operationId: "progress-2",
      body: "New findings after the follow-up",
      citationRefs: ["ov:known"],
    }),
  ).not.toThrow();
});

test("changing search snippets for the same source prompts a strategy pivot without capping reads", async () => {
  const proxy = fakeProxy((_path, raw) => {
    const command = raw as { protocol: string; op: string; operationId: string; query: string };
    return {
      ...emptyItemsResponse(command.protocol, command.op, command.operationId),
      items: [
        {
          kind: "openviking",
          citationId: "ov:known",
          workspaceId: "ws",
          accountId: "acct",
          uri: "viking://resources/doc.md",
          contentHash: "sha256:fixture",
          matchedLevel: "L2",
          excerpt: `Snippet selected for ${command.query}`,
        },
      ],
    };
  });
  const tools = createMemoryFenceTools(OPENVIKING_TOOL_PROFILE, new MemoryAgentTurnBudget(), proxy);
  let result;
  for (let i = 0; i < 4; i++)
    result = await executeTool(tools, OPENVIKING_TOOL_NAMES.forkFind, {
      operationId: `query-${i}`,
      query: `rephrasing ${i}`,
    });
  const text = result!.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  expect(text).toContain("causal/forks");
  expect(text).toContain("ov_read");
  expect(proxy.calls).toHaveLength(4);
});

test("even unchanged findings need a fresh Offer id for a new triggering request", () => {
  const budget = new MemoryAgentTurnBudget();
  const offer = {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "offer" as const,
    operationId: "old-request",
    body: "Same supported findings",
    citationRefs: ["ov:known"],
  };
  budget.consume(offer);
  budget.reset();
  expect(() => budget.consume(offer)).toThrow("earlier triggering request");
  expect(budget.snapshot().offers).toBe(0);
});

test("Fork discovery supplies an executable served-relation example before a method is adopted", async () => {
  const uri = "viking://resources/causal/forks/method.md";
  const proxy = fakeProxy((_path, raw) => ({
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "fork_find",
    operationId: (raw as { operationId: string }).operationId,
    duplicate: false,
    items: [
      {
        kind: "openviking",
        citationId: `ov:${uri}`,
        workspaceId: "ws",
        accountId: "acct",
        uri,
        contentHash: "sha256:fixture",
        matchedLevel: "L2",
        excerpt: "Candidate counterfactual method",
      },
    ],
    retrieval: {
      mode: "bm25",
      chainRef: "served-chain",
      step: 0,
      remainingHops: 4,
      exhausted: false,
      nodes: [
        {
          uri,
          kind: "fork_overlay",
          status: "counterfactual",
          sourceRef: "fork-a",
          relations: ["branch_steps"],
        },
      ],
    },
  }));
  const tools = createMemoryFenceTools(OPENVIKING_TOOL_PROFILE, new MemoryAgentTurnBudget(), proxy);
  const result = await executeTool(tools, "ov_fork_find", {
    operationId: "find-method",
    query: "constraint intersection",
  });
  const guidance = result.content
    .slice(1)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  expect(guidance).toContain('"chainRef":"served-chain"');
  expect(guidance).toContain('"relation":"branch_steps"');
  expect(guidance).toContain(uri);
  expect(proxy.calls).toHaveLength(1);
});

test("new discovery IDs do not hide a search-only loop and a full read clears its warning", async () => {
  const budget = new MemoryAgentTurnBudget();
  const proxy = fakeProxy((_path, raw) => {
    const command = raw as { protocol: string; op: string; operationId: string; uri?: string };
    const citation = {
      kind: "openviking",
      citationId: `ov:${command.operationId}`,
      workspaceId: "ws",
      accountId: "acct",
      uri: command.uri ?? `viking://resources/evo-ir/documents/${command.operationId}.md`,
      contentHash: "sha256:fixture",
      matchedLevel: "L2",
      excerpt: "A discovery candidate, not verified support for every constraint.",
    };
    return command.op === "read"
      ? {
          protocol: command.protocol,
          op: "read",
          operationId: command.operationId,
          duplicate: false,
          citation,
          content: "Read document body.",
        }
      : {
          ...emptyItemsResponse(command.protocol, command.op, command.operationId),
          items: [citation],
        };
  });
  const tools = createMemoryFenceTools(OPENVIKING_TOOL_PROFILE, budget, proxy);
  let output = "";
  for (let index = 0; index < 4; index++) {
    if (index === 2) budget.reset();
    const result = await executeTool(tools, OPENVIKING_TOOL_NAMES.forkFind, {
      operationId: `find-${index}`,
      query: `different ${index}`,
    });
    output = result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  }
  expect(output).toContain("4 discovery calls without a new document read");
  expect(output).toContain('"uri":"viking://resources/evo-ir/documents/find-3.md"');
  expect(output).toContain("disconfirm");
  await executeTool(tools, OPENVIKING_TOOL_NAMES.read, {
    operationId: "read-1",
    uri: "viking://resources/evo-ir/documents/find-3.md",
  });
  const afterRead = await executeTool(tools, OPENVIKING_TOOL_NAMES.forkFind, {
    operationId: "find-after-read",
    query: "next constraint",
  });
  expect(
    afterRead.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
  ).not.toContain("discovery calls without");
  for (let index = 0; index < 2; index++)
    await executeTool(tools, OPENVIKING_TOOL_NAMES.forkFind, {
      operationId: `more-${index}`,
      query: "another keyword",
    });
  await executeTool(tools, OPENVIKING_TOOL_NAMES.read, {
    operationId: "read-fork",
    uri: "viking://resources/causal/forks/method.md",
  });
  await executeTool(tools, OPENVIKING_TOOL_NAMES.read, {
    operationId: "read-again",
    uri: "viking://resources/evo-ir/documents/find-3.md",
  });
  const stillStalled = await executeTool(tools, OPENVIKING_TOOL_NAMES.forkFind, {
    operationId: "still-stalled",
    query: "changed again",
  });
  expect(
    stillStalled.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
  ).toContain("4 discovery calls without a new document read");
  expect(proxy.calls).toHaveLength(11);
});

test("document discovery stays compact and repeated snippets do not hide full read access", async () => {
  const full = "Candidate biography. ".repeat(45) + "Decisive school name: Example Academy.";
  const citation = {
    kind: "openviking",
    citationId: "ov:biography",
    workspaceId: "ws",
    accountId: "acct",
    uri: "viking://resources/evo-ir/documents/biography.md",
    contentHash: "sha256:biography",
    matchedLevel: "L2",
    excerpt: full,
  };
  const proxy = fakeProxy((_path, raw) => {
    const command = raw as { protocol: string; op: string; operationId: string; query?: string };
    const served =
      command.query === "method"
        ? { ...citation, uri: "viking://resources/causal/forks/method.md" }
        : command.query === "updated"
          ? { ...citation, contentHash: "sha256:new-version" }
          : citation;
    return command.op === "read"
      ? {
          protocol: command.protocol,
          op: "read",
          operationId: command.operationId,
          duplicate: false,
          citation,
          content: full,
        }
      : {
          ...emptyItemsResponse(command.protocol, command.op, command.operationId),
          items: [served],
        };
  });
  const budget = new MemoryAgentTurnBudget();
  const tools = createMemoryFenceTools(OPENVIKING_TOOL_PROFILE, budget, proxy);
  const first = await executeTool(tools, OPENVIKING_TOOL_NAMES.searchContext, {
    operationId: "discover",
    query: "biography school",
  });
  budget.reset();
  const second = await executeTool(tools, OPENVIKING_TOOL_NAMES.searchContext, {
    operationId: "rediscover",
    query: "school biography",
  });
  const decode = (result: typeof first) =>
    JSON.parse(result.content.find((part) => part.type === "text")!.text);
  const card = decode(first).items[0];
  expect(card.uri).toBe(citation.uri);
  expect(card.contentHash).toBe(citation.contentHash);
  expect(card.excerpt.length).toBeLessThanOrEqual(480);
  expect(decode(first).discoveryNotes[0].note).toContain("ov_read");
  expect(card.excerpt).not.toContain("Decisive school name");
  expect(decode(second).items[0].excerpt).toBe("");
  expect(decode(second).discoveryNotes[0].note).toContain("Previously discovered");
  const read = await executeTool(tools, OPENVIKING_TOOL_NAMES.read, {
    operationId: "verify",
    uri: card.uri,
  });
  expect(decode(read).content).toBe(full);
  expect(decode(read).content).toContain("Example Academy");
  const updated = await executeTool(tools, OPENVIKING_TOOL_NAMES.searchContext, {
    operationId: "updated",
    query: "updated",
  });
  expect(decode(updated).items[0].excerpt).toBe(full.slice(0, 480));
  expect(decode(updated).items[0].contentHash).toBe("sha256:new-version");
  for (const operationId of ["method-first", "method-again"]) {
    const method = await executeTool(tools, OPENVIKING_TOOL_NAMES.searchContext, {
      operationId,
      query: "method",
    });
    expect(decode(method).items[0].excerpt).toBe(full);
    expect(decode(method).discoveryNotes).toBeUndefined();
  }
  expect(proxy.calls).toHaveLength(6);
});

test("restored context search forwards query and shared budget without mutation tools", async () => {
  const proxy = fakeProxy();
  const tools = createMemoryFenceTools(OPENVIKING_TOOL_PROFILE, new MemoryAgentTurnBudget(), proxy);
  await executeTool(tools, OPENVIKING_TOOL_NAMES.searchContext, {
    operationId: "context-restore-1",
    query: "first wife",
    tokenBudget: 800,
  });
  expect(proxy.calls[0].body).toMatchObject({
    op: "search_context",
    query: "first wife",
    tokenBudget: 800,
  });
});

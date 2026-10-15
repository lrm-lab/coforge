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
    "ov_find",
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
    OPENVIKING_TOOL_NAMES.find,
    OPENVIKING_TOOL_NAMES.expand,
    OPENVIKING_TOOL_NAMES.read,
    OPENVIKING_TOOL_NAMES.offer,
    OPENVIKING_TOOL_NAMES.diagnose,
    ...CHANNEL_MESSAGE_TOOLS,
  ]);
  expect(names.some((name) => name.startsWith("causal_"))).toBe(false);
  expect(MUTATION_TOOL_NAMES.some((name) => names.includes(name))).toBe(false);
});

test("a fourth memory read is rejected", () => {
  const budget = new MemoryAgentTurnBudget();
  const find = {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "find" as const,
    operationId: "f1",
    query: "deploy",
  };
  budget.consume(find);
  budget.consume({ ...find, operationId: "f2" });
  budget.consume({ ...find, operationId: "f3" });
  expect(() => budget.consume({ ...find, operationId: "f4" })).toThrow("read budget");
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
    executeTool(tools, OPENVIKING_TOOL_NAMES.find, {
      operationId: "too-many",
      query: "deploy",
      limit: 11,
    }),
  ).rejects.toThrow("invalid openviking find limit");
  expect(proxy.calls).toEqual([]);
});

test("reset restores reads and offers for the next triggering message", () => {
  const budget = new MemoryAgentTurnBudget();
  const find = {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "find" as const,
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
  await executeTool(tools, OPENVIKING_TOOL_NAMES.find, {
    operationId: "find-1",
    query: "deploy rollback",
    limit: 10,
  });
  expect(proxy.calls).toEqual([
    {
      path: agentApiRoutes.proxy.openviking.path,
      body: {
        protocol: OPENVIKING_AGENT_PROTOCOL,
        op: "find",
        operationId: "find-1",
        query: "deploy rollback",
        limit: 10,
      },
    },
  ]);
  expect(JSON.stringify(proxy.calls[0]?.body)).not.toContain("write");
  expect(JSON.stringify(proxy.calls[0]?.body)).not.toContain("commit");
});

test("openviking-memory search_context keeps the 3-read cap", () => {
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
  expect(() => budget.consume({ ...searchContext, operationId: "c4" })).toThrow("read budget");
});

test("empty ov_find arguments return an example error and do not spend the read budget", async () => {
  const budget = new MemoryAgentTurnBudget();
  const proxy = fakeProxy();
  const tools = createMemoryFenceTools(OPENVIKING_TOOL_PROFILE, budget, proxy);
  const find = tools.find((tool) => tool.name === OPENVIKING_TOOL_NAMES.find);
  expect(typeof find?.prepareArguments).toBe("function");
  expect(() => find?.prepareArguments?.({})).toThrow(/missing operationId, query/);
  expect(() => find?.prepareArguments?.({})).toThrow(/\{"operationId": "find-1"/);
  await expect(executeTool(tools, OPENVIKING_TOOL_NAMES.find, {})).rejects.toThrow(
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

test("Memory does not expose ov_search_context", () => {
  const tools = createMemoryFenceTools(
    OPENVIKING_TOOL_PROFILE,
    new MemoryAgentTurnBudget(),
    fakeProxy(),
  );
  expect(tools.some((tool) => tool.name === "ov_search_context")).toBe(false);
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

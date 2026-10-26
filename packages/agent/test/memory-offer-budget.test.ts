import { expect, test } from "bun:test";
import { OPENVIKING_TOOL_PROFILE, OPENVIKING_AGENT_PROTOCOL } from "@lrm/coforge-sdk/agent";
import { createMemoryFenceTools, MemoryAgentTurnBudget } from "../src/runner";
import { AgentProxyError } from "../src/agent-proxy-error";

const params = { operationId: "offer-a", body: "Evidence", citationRefs: ["ov:a"] };
const rejected = { phase: "rejected_before_publish" };
function failure(publication: unknown, operationId = params.operationId) {
  return new AgentProxyError(400, {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    operationId,
    error: { code: "openviking-citation-ungrounded", message: "citation was not served" },
    ...(publication === undefined ? {} : { publication }),
  });
}
function harness(post: (body: unknown) => Promise<unknown>) {
  const budget = new MemoryAgentTurnBudget();
  const tool = createMemoryFenceTools(OPENVIKING_TOOL_PROFILE, budget, {
    post: (_path, body) => post(body),
  }).find((t) => t.name === "memory_offer")!;
  return {
    budget,
    send: (args = params) => tool.execute("call", args, undefined, undefined, undefined as never),
  };
}
function receipt(operationId: string) {
  return {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "offer",
    operationId,
    published: true,
    duplicate: true,
    messageId: "message-a",
    citations: [],
    publication: { phase: "published", messageId: "message-a" },
  };
}

test("a matching prepublish refusal preserves structured failure and frees the Offer slot", async () => {
  const error = failure(rejected);
  const { send, budget } = harness(async () => {
    throw error;
  });
  await expect(send()).rejects.toBe(error);
  expect(error).toMatchObject({
    status: 400,
    code: "openviking-citation-ungrounded",
    operationId: "offer-a",
    publication: rejected,
  });
  expect(budget.snapshot().offers).toBe(0);
  await expect(send({ ...params, operationId: "offer-b" })).rejects.toBe(error);
});

for (const publication of [
  undefined,
  {},
  { phase: "published", messageId: "message-a" },
  { phase: "rejected_before_publish", messageId: "contradiction" },
  { phase: "published", messageId: "" },
]) {
  test(`uncertain or published failure keeps its slot: ${JSON.stringify(publication)}`, async () => {
    const { send, budget } = harness(async () => {
      throw failure(publication);
    });
    await expect(send()).rejects.toThrow("citation was not served");
    expect(budget.snapshot().offers).toBe(1);
    await expect(send({ ...params, operationId: "offer-b" })).rejects.toThrow("offer budget");
  });
}

test("a refusal correlated to another operation cannot refund the current slot", async () => {
  const { send, budget } = harness(async () => {
    throw failure(rejected, "other");
  });
  await expect(send()).rejects.toThrow();
  expect(budget.snapshot().offers).toBe(1);
});

test("a lost response allows only identical same-ID recovery", async () => {
  let calls = 0;
  const { send, budget } = harness(async (body) => {
    if (++calls === 1) throw new Error("response lost");
    return receipt((body as typeof params).operationId);
  });
  await expect(send()).rejects.toThrow("response lost");
  await expect(send({ ...params, operationId: "new" })).rejects.toThrow("offer budget");
  await expect(send({ ...params, body: "Changed" })).rejects.toThrow("different Offer");
  const result = await send();
  expect(JSON.parse(result.content.filter((item) => item.type === "text")[0]!.text)).toMatchObject({
    messageId: "message-a",
    duplicate: true,
  });
  expect(calls).toBe(2);
  expect(budget.snapshot().offers).toBe(1);
});

test("a pending Offer cannot overlap a new ID or another same-ID request", async () => {
  const gate = Promise.withResolvers<unknown>();
  let calls = 0;
  const { send } = harness(async () => {
    calls++;
    return gate.promise;
  });
  const pending = send();
  try {
    await expect(send({ ...params, operationId: "other" })).rejects.toThrow("offer budget");
    await expect(send()).rejects.toThrow("pending");
    expect(calls).toBe(1);
  } finally {
    gate.resolve(receipt(params.operationId));
    await pending;
  }
});

test("a late prepublish reply from the old trigger cannot release the new trigger", async () => {
  const gate = Promise.withResolvers<unknown>();
  const { send, budget } = harness(async (body) => {
    if ((body as typeof params).operationId === "offer-a") return gate.promise;
    return receipt("offer-b");
  });
  const pending = send();
  try {
    budget.reset();
    await send({ ...params, operationId: "offer-b" });
    gate.reject(failure(rejected));
    await expect(pending).rejects.toThrow();
    expect(budget.snapshot().offers).toBe(1);
  } finally {
    gate.resolve(receipt("offer-a"));
    await pending.catch(() => undefined);
  }
});

test("the real HTTP proxy preserves status, code and publication for native tool recovery", async () => {
  const endpoint = Bun.env.COFORGE_AGENT_PROXY_URL;
  const context = Bun.env.COFORGE_AGENT_CONTEXT;
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as typeof params;
      if (++calls === 1)
        return Response.json(
          {
            protocol: OPENVIKING_AGENT_PROTOCOL,
            operationId: body.operationId,
            error: { code: "openviking-citation-ungrounded", message: "not served" },
            publication: rejected,
          },
          { status: 400 },
        );
      return Response.json(receipt(body.operationId));
    },
  });
  try {
    Bun.env.COFORGE_AGENT_PROXY_URL = server.url.href;
    Bun.env.COFORGE_AGENT_CONTEXT = "isolated-test-context";
    const budget = new MemoryAgentTurnBudget();
    const tool = createMemoryFenceTools(OPENVIKING_TOOL_PROFILE, budget).find(
      (entry) => entry.name === "memory_offer",
    )!;
    const send = (operationId: string) =>
      tool.execute("call", { ...params, operationId }, undefined, undefined, undefined as never);
    await expect(send("http-a")).rejects.toMatchObject({
      status: 400,
      code: "openviking-citation-ungrounded",
      operationId: "http-a",
      publication: rejected,
    });
    expect(budget.snapshot().offers).toBe(0);
    await send("http-b");
    expect(calls).toBe(2);
    expect(budget.snapshot().offers).toBe(1);
  } finally {
    if (endpoint === undefined) delete Bun.env.COFORGE_AGENT_PROXY_URL;
    else Bun.env.COFORGE_AGENT_PROXY_URL = endpoint;
    if (context === undefined) delete Bun.env.COFORGE_AGENT_CONTEXT;
    else Bun.env.COFORGE_AGENT_CONTEXT = context;
    await server.stop(true);
  }
});

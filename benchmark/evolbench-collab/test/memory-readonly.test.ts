import { expect, test } from "bun:test";
import { OPENVIKING_AGENT_PROTOCOL } from "../../../packages/coforge-sdk/src/agent/openviking-memory";
import { guardWarmMemoryWrites } from "../src/memory-readonly";
import { startAgentProxy } from "../../../packages/daemon/src/agent-proxy";

const diagnosis = {
  protocol: OPENVIKING_AGENT_PROTOCOL,
  op: "diagnose",
  operationId: "diag-1",
  messageId: "01a176cc-2bbf-75ae-8002-627592daa50f",
} as const;

test("readonly warm diagnosis never reaches the session writer", async () => {
  let writes = 0;
  const guarded = guardWarmMemoryWrites(
    async () => {
      writes++;
    },
    "warm",
    true,
  );
  expect(await guarded("context", diagnosis, "key")).toEqual({
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "diagnose",
    operationId: "diag-1",
    duplicate: false,
    status: "failed",
    published: false,
    reason: "eval_warm_readonly",
  });
  expect(writes).toBe(0);
});

test("flag off and cold preserve exact forwarding arguments and response bytes", async () => {
  for (const [arm, readonly] of [
    ["warm", false],
    ["cold", true],
  ] as const) {
    const response = new Response(' {"status":"running", "opaque":true}\n', { status: 202 });
    const guarded = guardWarmMemoryWrites(
      async (...args) => {
        expect(args).toEqual(["context", diagnosis, "key"]);
        return response;
      },
      arm,
      readonly,
    );
    const actual = await guarded("context", diagnosis, "key");
    expect(actual).toBe(response);
    expect(await (actual as Response).text()).toBe(' {"status":"running", "opaque":true}\n');
  }
});

test("readonly warm still forwards retrieval and Offers unchanged", async () => {
  const result = { opaque: "unchanged" };
  const guarded = guardWarmMemoryWrites(async () => result, "warm", true);
  for (const op of ["experience_find", "fork_find", "read", "expand", "search_context", "offer"]) {
    const request = { ...diagnosis, op } as Parameters<typeof guarded>[1];
    expect(await guarded("context", request, "key")).toBe(result);
  }
});

test("only the explicit environment value 1 enables the warm guard", async () => {
  const before = Bun.env.COFORGE_EVAL_WARM_READONLY;
  try {
    for (const value of [undefined, "0", "1"]) {
      if (value === undefined) delete Bun.env.COFORGE_EVAL_WARM_READONLY;
      else Bun.env.COFORGE_EVAL_WARM_READONLY = value;
      let forwarded = false;
      await guardWarmMemoryWrites(async () => {
        forwarded = true;
      }, "warm")("context", diagnosis, "key");
      expect(forwarded).toBe(value !== "1");
    }
  } finally {
    if (before === undefined) delete Bun.env.COFORGE_EVAL_WARM_READONLY;
    else Bun.env.COFORGE_EVAL_WARM_READONLY = before;
  }
});

test("real Agent HTTP proxy gates diagnosis before the web session writer", async () => {
  let writes = 0;
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      memoryFence: () => "openviking-memory",
      agentOpenviking: guardWarmMemoryWrites(
        async () => {
          writes++;
          throw new Error("must not reach the writer");
        },
        "warm",
        true,
      ),
    },
  });
  try {
    const token = proxy.issue("memory", `sk_agent_${"a".repeat(43)}`);
    const response = await fetch(new URL("/api/agent/v1/openviking", proxy.url), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(diagnosis),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "failed", reason: "eval_warm_readonly" });
    expect(writes).toBe(0);
  } finally {
    proxy.close();
  }
});

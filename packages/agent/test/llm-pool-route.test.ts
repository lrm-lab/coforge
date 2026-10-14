import { expect, test, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runtimeFetch, configureRuntimeEnvironment } from "#src/runtime-provider";

test("session model requests join the common pool and keep authentication", async () => {
  const seen: { path: string; authorization: string | null }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      seen.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
      });
      return Response.json(await request.json());
    },
  });
  try {
    const request = runtimeFetch({
      COFORGE_LLM_POOL_URL: `http://127.0.0.1:${server.port}`,
      NO_PROXY: "127.0.0.1",
    });
    const result = await request("https://modelfactory.lenovo.com/llm/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer test-key" },
      body: '{"model":"gemma-4-31B-it"}',
    });
    expect(await result.json()).toEqual({ model: "gemma-4-31B-it" });
    expect(seen).toEqual([{ path: "/llm/v1/chat/completions", authorization: "Bearer test-key" }]);
  } finally {
    server.stop(true);
  }
});

test("pooled Gemma streams allow the full retry budget without SDK retry multiplication", async () => {
  const root = await mkdtemp(join(tmpdir(), "pool-sdk-timeout-"));
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(root, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(root, "models.json"),
      refreshOnCreate: false,
    });
    const model = runtime.getModel("openai", "gpt-4o");
    if (!model) throw new Error("SDK static test model unavailable");
    const stream = spyOn(runtime, "stream").mockImplementation(() => {
      throw new Error("captured stream");
    });
    const simple = spyOn(runtime, "streamSimple").mockImplementation(() => {
      throw new Error("captured stream");
    });
    try {
      configureRuntimeEnvironment(runtime, { COFORGE_LLM_POOL_URL: "http://127.0.0.1:18740" });
      const context = { messages: [] };
      const gemma = {
        ...model,
        id: "gemma-4-31B-it",
        baseUrl: "https://modelfactory.lenovo.com/llm/v1",
      };
      expect(() => runtime.stream(gemma, context, { timeoutMs: 111, maxRetries: 2 })).toThrow(
        "captured stream",
      );
      expect(() => runtime.streamSimple(gemma, context, { timeoutMs: 111, maxRetries: 2 })).toThrow(
        "captured stream",
      );
      expect(stream.mock.calls[0]?.[2]).toMatchObject({ timeoutMs: 960000, maxRetries: 0 });
      expect(simple.mock.calls[0]?.[2]).toMatchObject({ timeoutMs: 960000, maxRetries: 0 });
      expect(() => runtime.stream(model, context, { timeoutMs: 111, maxRetries: 2 })).toThrow(
        "captured stream",
      );
      expect(stream.mock.calls[1]?.[2]).toMatchObject({ timeoutMs: 111, maxRetries: 2 });
      const otherGemma = { ...gemma, baseUrl: "https://openrouter.ai/api/v1" };
      expect(() => runtime.stream(otherGemma, context, { timeoutMs: 222, maxRetries: 3 })).toThrow(
        "captured stream",
      );
      expect(stream.mock.calls[2]?.[2]).toMatchObject({ timeoutMs: 222, maxRetries: 3 });
    } finally {
      stream.mockRestore();
      simple.mockRestore();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

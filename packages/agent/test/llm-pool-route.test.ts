import { expect, test } from "bun:test";
import { runtimeFetch } from "#src/runtime-provider";

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

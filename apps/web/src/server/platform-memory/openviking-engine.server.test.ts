import { expect, test } from "bun:test";
import { OpenVikingMemoryEngine } from "./openviking-engine.server";
import { memoryRoot } from "./contract";
const ws = "11111111-1111-4111-8111-111111111111";
const agent = "22222222-2222-4222-8222-222222222222";
const document = { title: "Release", content: "Run the tests", kind: "fact" as const };
test("the engine uses one native semantic search over only the authorized roots", async () => {
  const roots = [memoryRoot(ws, null), memoryRoot(ws, agent)];
  const currentUris = roots.map((root) => `${root}/entry/version.json`);
  const calls: unknown[] = [];
  const engine = new OpenVikingMemoryEngine(
    async () => ({
      baseUrl: "https://memory.invalid",
      token: "test-only-token",
      accountId: "tenant",
      userId: "service",
    }),
    async (url, init) => {
      expect(new URL(url).pathname).toBe("/api/v1/search/find");
      const body = JSON.parse(String(init.body));
      calls.push(body);
      expect(body.target_uri).toEqual(roots);
      expect(body.query).toBe("publishing");
      expect(body.filter).toEqual({ op: "must", field: "uri", conds: currentUris });
      return Response.json({
        status: "ok",
        result: {
          resources: [
            { uri: `${roots[0]}/entry/version.json` },
            { uri: "viking://resources/other/private" },
          ],
          memories: [{ uri: `${roots[1]}/entry/version.json` }],
        },
      });
    },
  );
  expect(await engine.search(ws, roots, "publishing", currentUris)).toEqual([
    `${roots[0]}/entry/version.json`,
    `${roots[1]}/entry/version.json`,
  ]);
  expect(calls).toHaveLength(1);
});
test("writes use the documented content API and wait for indexing; private content uses a user namespace", async () => {
  const uri = `${memoryRoot(ws, agent)}/entry/version.json`;
  const engine = new OpenVikingMemoryEngine(
    async () => ({
      baseUrl: "https://memory.invalid",
      token: "test-token",
      accountId: "tenant",
      userId: "service",
    }),
    async (url, init) => {
      if (init.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({ uri, mode: "replace", wait: true });
        expect(JSON.parse(body.content)).toEqual(document);
        return Response.json({
          status: "ok",
          result: { semantic_status: "complete", vector_status: "complete" },
        });
      }
      expect(new URL(url).searchParams.get("uri")).toBe(uri);
      return Response.json({ status: "ok", result: JSON.stringify(document) });
    },
  );
  await engine.write(ws, uri, document);
  expect(await engine.read(ws, uri)).toEqual(document);
  await expect(engine.read("33333333-3333-4333-8333-333333333333", uri)).rejects.toThrow(
    "memory_forbidden",
  );
});
test("a pending or failed index and a failed backend are not reported as success", async () => {
  const engine = new OpenVikingMemoryEngine(
    async () => ({
      baseUrl: "https://memory.invalid",
      token: "test-token",
      accountId: "tenant",
      userId: "service",
    }),
    async () => Response.json({ status: "ok", result: { semantic_status: "pending" } }),
  );
  await expect(engine.write(ws, `${memoryRoot(ws, null)}/entry/v.json`, document)).rejects.toThrow(
    "memory_unavailable",
  );
  const offline = new OpenVikingMemoryEngine(async () => {
    throw new Error("offline");
  });
  expect(await offline.available(ws)).toBe(false);
});
test("the engine stops oversized responses before buffering an unbounded body", async () => {
  let cancelled = false;
  let reads = 0;
  const engine = new OpenVikingMemoryEngine(
    async () => ({
      baseUrl: "https://memory.invalid",
      token: "test",
      accountId: "tenant",
      userId: "service",
    }),
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            reads++;
            if (reads > 20) controller.close();
            else controller.enqueue(new Uint8Array(100_000));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  await expect(engine.read(ws, `${memoryRoot(ws, agent)}/entry/version.json`)).rejects.toThrow(
    "memory_unavailable",
  );
  expect(cancelled).toBe(true);
  expect(reads).toBeLessThan(10);
});

test("resource writes require successful embeddings as well as semantic processing", async () => {
  const engine = new OpenVikingMemoryEngine(
    async () => ({
      baseUrl: "https://memory.invalid",
      token: "test",
      accountId: "tenant",
      userId: "service",
    }),
    async () =>
      Response.json({
        status: "ok",
        result: { semantic_status: "complete", vector_status: "failed" },
      }),
  );
  await expect(engine.write(ws, `${memoryRoot(ws, null)}/entry/v.json`, document)).rejects.toThrow(
    "memory_unavailable",
  );
  expect(memoryRoot(ws, agent)).toContain(`/resources/coforge-${ws}`);
});

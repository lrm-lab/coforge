import { afterEach, expect, test } from "bun:test";

import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("reads several channels' stream positions in one parallel batch of history calls", async () => {
  let request: Request | undefined;
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      request = new Request(input, init);
      return Promise.resolve(
        Response.json({
          replies: [
            { history: { publications: [], offset: 12, epoch: "e-workspace" } },
            // A stream nothing was published on yet may report no offset.
            { history: { publications: [], epoch: "e-user" } },
          ],
        }),
      );
    },
    { preconnect: originalFetch.preconnect },
  );

  const positions = await createCentrifugoServerApi({
    COFORGE_CENTRIFUGO_API_URL: "http://centrifugo.test/api",
    COFORGE_CENTRIFUGO_API_KEY: "test-api-key",
  }).streamPositions(["chat:workspace:w1", "chat:user:u1"]);

  // `history` without a limit returns only the stream position
  // (https://centrifugal.dev/docs/server/server_api#history).
  // Centrifugo answers 400 to `batch` in a `{ method, params }` body; the method goes in the path.
  expect(request?.url).toBe("http://centrifugo.test/api/batch");
  expect(request?.headers.get("x-api-key")).toBe("test-api-key");
  expect(await request?.json()).toEqual({
    parallel: true,
    commands: [
      { history: { channel: "chat:workspace:w1" } },
      { history: { channel: "chat:user:u1" } },
    ],
  });
  expect(positions).toEqual({
    "chat:workspace:w1": { offset: 12, epoch: "e-workspace" },
    "chat:user:u1": { offset: 0, epoch: "e-user" },
  });
});

test("a channel whose position could not be read is left out", async () => {
  globalThis.fetch = Object.assign(
    () =>
      Promise.resolve(
        Response.json({
          // 108: the channel's namespace keeps no history.
          replies: [{ error: { code: 108, message: "not available" } }, { history: {} }],
        }),
      ),
    { preconnect: originalFetch.preconnect },
  );

  const positions = await createCentrifugoServerApi({
    COFORGE_CENTRIFUGO_API_URL: "http://centrifugo.test/api",
    COFORGE_CENTRIFUGO_API_KEY: "test-api-key",
  }).streamPositions(["chat:workspace:w1", "chat:user:u1"]);

  expect(positions).toEqual({});
});

test("publishes many binary payloads in one parallel batch, settling each on its own reply", async () => {
  const requests: Request[] = [];
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requests.push(new Request(input, init));
      return Promise.resolve(
        Response.json({
          replies: [
            { publish: {} },
            // https://centrifugal.dev/docs/server/server_api#batch: each reply carries its own error.
            { error: { code: 102, message: "unknown channel" } },
            { publish: {} },
          ],
        }),
      );
    },
    { preconnect: originalFetch.preconnect },
  );

  const results = await createCentrifugoServerApi({
    COFORGE_CENTRIFUGO_API_URL: "http://centrifugo.test/api",
    COFORGE_CENTRIFUGO_API_KEY: "test-api-key",
  }).publishBatch([
    { channel: "daemon:w:c1", data: Uint8Array.of(0, 255, 42) },
    { channel: "daemon:w:c2", data: Uint8Array.of(1) },
    { channel: "daemon:w:c1", data: Uint8Array.of(2) },
  ]);

  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("http://centrifugo.test/api/batch");
  expect(requests[0]?.headers.get("x-api-key")).toBe("test-api-key");
  expect(await requests[0]?.json()).toEqual({
    parallel: true,
    commands: [
      { publish: { channel: "daemon:w:c1", b64data: "AP8q" } },
      { publish: { channel: "daemon:w:c2", b64data: "AQ==" } },
      { publish: { channel: "daemon:w:c1", b64data: "Ag==" } },
    ],
  });
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  expect((results[1] as PromiseRejectedResult).reason).toEqual(
    new Error("Centrifugo publish failed (102)"),
  );
});

test("a batch Centrifugo did not answer fails every publication in it", async () => {
  globalThis.fetch = Object.assign(() => Promise.resolve(new Response(null, { status: 503 })), {
    preconnect: originalFetch.preconnect,
  });

  const results = await createCentrifugoServerApi({
    COFORGE_CENTRIFUGO_API_URL: "http://centrifugo.test/api",
    COFORGE_CENTRIFUGO_API_KEY: "test-api-key",
  }).publishBatch([
    { channel: "daemon:w:c1", data: Uint8Array.of(1) },
    { channel: "daemon:w:c2", data: Uint8Array.of(2) },
  ]);

  expect(results).toEqual([
    { status: "rejected", reason: new Error("Centrifugo batch failed (503)") },
    { status: "rejected", reason: new Error("Centrifugo batch failed (503)") },
  ]);
});

test("an empty batch makes no Centrifugo call", async () => {
  let called = false;
  globalThis.fetch = Object.assign(
    () => {
      called = true;
      return Promise.resolve(Response.json({ replies: [] }));
    },
    { preconnect: originalFetch.preconnect },
  );

  const results = await createCentrifugoServerApi({
    COFORGE_CENTRIFUGO_API_URL: "http://centrifugo.test/api",
    COFORGE_CENTRIFUGO_API_KEY: "test-api-key",
  }).publishBatch([]);

  expect(results).toEqual([]);
  expect(called).toBe(false);
});

test("a batch Centrifugo refused as a whole fails each publication with its error", async () => {
  globalThis.fetch = Object.assign(
    () => Promise.resolve(Response.json({ error: { code: 103, message: "permission denied" } })),
    { preconnect: originalFetch.preconnect },
  );

  const results = await createCentrifugoServerApi({
    COFORGE_CENTRIFUGO_API_URL: "http://centrifugo.test/api",
    COFORGE_CENTRIFUGO_API_KEY: "test-api-key",
  }).publishBatch([{ channel: "daemon:w:c1", data: Uint8Array.of(1) }]);

  expect(results).toEqual([
    { status: "rejected", reason: new Error("Centrifugo batch failed (103)") },
  ]);
});

test("publishes many JSON payloads in one parallel batch, each with its own idempotency key", async () => {
  const requests: Request[] = [];
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requests.push(new Request(input, init));
      return Promise.resolve(
        Response.json({
          replies: [
            { publish: {} },
            // https://centrifugal.dev/docs/server/server_api#batch: each reply carries its own error.
            { error: { code: 102, message: "unknown channel" } },
          ],
        }),
      );
    },
    { preconnect: originalFetch.preconnect },
  );

  const results = await createCentrifugoServerApi({
    COFORGE_CENTRIFUGO_API_URL: "http://centrifugo.test/api",
    COFORGE_CENTRIFUGO_API_KEY: "test-api-key",
  }).publishJsonBatch([
    { channel: "chat:user:u1", data: { type: "channel.marked.v1" }, idempotencyKey: "k1" },
    { channel: "chat:user:u1", data: { type: "dm.marked.v1" } },
  ]);

  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("http://centrifugo.test/api/batch");
  expect(await requests[0]?.json()).toEqual({
    parallel: true,
    commands: [
      {
        publish: {
          channel: "chat:user:u1",
          data: { type: "channel.marked.v1" },
          idempotency_key: "k1",
        },
      },
      { publish: { channel: "chat:user:u1", data: { type: "dm.marked.v1" } } },
    ],
  });
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
  expect((results[1] as PromiseRejectedResult).reason).toEqual(
    new Error("Centrifugo publish failed (102)"),
  );
});

test("a JSON batch Centrifugo did not answer fails every publication in it", async () => {
  globalThis.fetch = Object.assign(() => Promise.resolve(new Response(null, { status: 503 })), {
    preconnect: originalFetch.preconnect,
  });

  const results = await createCentrifugoServerApi({
    COFORGE_CENTRIFUGO_API_URL: "http://centrifugo.test/api",
    COFORGE_CENTRIFUGO_API_KEY: "test-api-key",
  }).publishJsonBatch([
    { channel: "chat:user:u1", data: { type: "channel.marked.v1" } },
    { channel: "chat:user:u2", data: { type: "dm.marked.v1" } },
  ]);

  expect(results).toEqual([
    { status: "rejected", reason: new Error("Centrifugo batch failed (503)") },
    { status: "rejected", reason: new Error("Centrifugo batch failed (503)") },
  ]);
});

test("an empty JSON batch makes no Centrifugo call", async () => {
  let called = false;
  globalThis.fetch = Object.assign(
    () => {
      called = true;
      return Promise.resolve(Response.json({ replies: [] }));
    },
    { preconnect: originalFetch.preconnect },
  );

  const results = await createCentrifugoServerApi({
    COFORGE_CENTRIFUGO_API_URL: "http://centrifugo.test/api",
    COFORGE_CENTRIFUGO_API_KEY: "test-api-key",
  }).publishJsonBatch([]);

  expect(results).toEqual([]);
  expect(called).toBe(false);
});

import { afterAll, expect, test } from "bun:test";
import { createComputerSelfClient } from "#src/connection/computer-self-client";

const DK = `dk_${"a".repeat(43)}`;
const SK = `sk_computer_${"b".repeat(43)}`;
const NEVER = new AbortController().signal;

type Request = { path: string; authorization: string | null };
const requests: Request[] = [];
let handler: (req: Request) => Response | Promise<Response> = () => new Response("{}");

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const request = {
      path: new URL(req.url).pathname,
      authorization: req.headers.get("authorization"),
    };
    requests.push(request);
    return handler(request);
  },
});
afterAll(() => server.stop(true));
const base = `http://127.0.0.1:${server.port}`;
const before = () => {
  requests.length = 0;
  handler = () => new Response("{}");
};

test("swap-key posts the bearer key to the route and reads the minted key", async () => {
  before();
  handler = () => Response.json({ apiKey: SK });
  const result = await createComputerSelfClient(base).swapKey(DK, NEVER);
  expect(result).toEqual({ ok: true, value: { apiKey: SK } });
  expect(requests).toEqual([{ path: "/api/computer/swap-key", authorization: `Bearer ${DK}` }]);
});

test("confirm-key posts and accepts the route's ok", async () => {
  before();
  handler = () => Response.json({ ok: true });
  const result = await createComputerSelfClient(base).confirmKey(SK, NEVER);
  expect(result).toEqual({ ok: true, value: {} });
  expect(requests[0]).toEqual({
    path: "/api/computer/confirm-key",
    authorization: `Bearer ${SK}`,
  });
});

test.each([404, 405])(
  "a %d answers 'unsupported' — an older server, never retried",
  async (status) => {
    before();
    handler = () => new Response("nope", { status });
    const result = await createComputerSelfClient(base).swapKey(DK, NEVER);
    expect(result).toEqual({ ok: false, error: { kind: "unsupported", detail: `http ${status}` } });
  },
);

test.each([401, 403, 500])(
  "a %d answers 'retryable' — the old key stays for this start",
  async (status) => {
    before();
    handler = () => new Response("nope", { status });
    const result = await createComputerSelfClient(base).swapKey(DK, NEVER);
    expect(result).toEqual({ ok: false, error: { kind: "retryable", detail: `http ${status}` } });
  },
);

test("a malformed body answers 'retryable' — nothing is trusted", async () => {
  before();
  handler = () => Response.json({ apiKey: 42 });
  const result = await createComputerSelfClient(base).swapKey(DK, NEVER);
  expect(result).toEqual({ ok: false, error: { kind: "retryable", detail: "malformed response" } });
});

test("a server URL with a path or trailing slash still reaches the API routes", async () => {
  before();
  handler = () => Response.json({ ok: true });
  for (const url of [`${base}/`, `${base}/daemon/v1`]) {
    const result = await createComputerSelfClient(url).confirmKey(SK, NEVER);
    expect(result).toEqual({ ok: true, value: {} });
  }
  expect(requests.map((r) => r.path)).toEqual([
    "/api/computer/confirm-key",
    "/api/computer/confirm-key",
  ]);
});

test("a hung server answers 'retryable' after the timeout instead of stalling the start", async () => {
  before();
  handler = () => new Promise<Response>(() => {});
  const result = await createComputerSelfClient(base, 50).swapKey(DK, NEVER);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.kind).toBe("retryable");
});

test("a hung server yields to the caller's abort instead of the timeout", async () => {
  before();
  handler = () => new Promise<Response>(() => {});
  const controller = new AbortController();
  const pending = createComputerSelfClient(base, 60_000).swapKey(DK, controller.signal);
  setTimeout(() => controller.abort(), 20);
  const started = Date.now();
  const result = await pending;
  expect(Date.now() - started).toBeLessThan(60_000);
  expect(result.ok).toBe(false);
});

test("detach reads the 410 computer_key_revoked as a definite key_revoked, not a retry", async () => {
  before();
  handler = () => Response.json({ error: "computer_key_revoked" }, { status: 410 });
  const result = await createComputerSelfClient(base).detach(SK, NEVER);
  expect(result).toEqual({ ok: true, value: "key_revoked" });
});

test("detach reads an ordinary 401 as retryable, never a confirmed detach", async () => {
  before();
  handler = () => Response.json({ error: "unauthenticated" }, { status: 401 });
  const result = await createComputerSelfClient(base).detach(SK, NEVER);
  expect(result).toMatchObject({ ok: false, error: { kind: "retryable" } });
});

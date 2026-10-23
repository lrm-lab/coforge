import { afterAll, beforeAll, expect, test } from "bun:test";
import { fetchAgentManifest } from "#src/manifest-fetch";

const MANIFEST = {
  schema: "coforge-agent-manifest.v1",
  execution: { mode: "http_api", base_url: "https://notes.test/api" },
  actions: [],
};

let server: ReturnType<typeof Bun.serve>;
const handlers = new Map<string, () => Response | Promise<Response>>();
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (request) =>
      handlers.get(new URL(request.url).pathname)?.() ?? new Response("", { status: 404 }),
  });
});
afterAll(() => server.stop(true));

/** The app's https URLs live on `*.test`; the injected fetch sends them to the local server. */
const toLocal = (input: string | URL | Request) => {
  const url = new URL(String(input));
  return `http://127.0.0.1:${server.port}${url.pathname}${url.search}`;
};
const localFetch = (input: string | URL | Request, init?: RequestInit) =>
  fetch(toLocal(input), init);

const get = (path: string, options: { timeoutMs?: number } = {}) =>
  fetchAgentManifest({ url: `https://notes.test${path}`, fetch: localFetch, ...options });

test("a valid manifest comes back parsed", async () => {
  let accept = "";
  handlers.set("/m.json", () => json(MANIFEST));
  const outcome = await fetchAgentManifest({
    url: "https://notes.test/m.json",
    fetch: (input, init) => {
      accept = new Headers(init?.headers).get("accept") ?? "";
      return localFetch(input, init);
    },
  });
  expect(outcome.kind).toBe("valid");
  expect(accept).toBe("application/json");
  handlers.set("/ld.json", () =>
    json(MANIFEST, { headers: { "content-type": "application/manifest+json; charset=utf-8" } }),
  );
  expect((await get("/ld.json")).kind).toBe("valid");
});

test("404 and 410 are missing (absent when derived); 429 and 5xx are unavailable and keep retry-after", async () => {
  handlers.set("/404", () => new Response("", { status: 404 }));
  handlers.set("/410", () => new Response("", { status: 410 }));
  handlers.set("/429", () => new Response("", { status: 429, headers: { "retry-after": "30" } }));
  handlers.set("/503", () => new Response("", { status: 503 }));
  handlers.set("/403", () => new Response("", { status: 403 }));
  expect(await get("/404")).toEqual({ kind: "missing", status: 404 });
  expect(await get("/410")).toEqual({ kind: "missing", status: 410 });
  // At a URL the CLI derived from the homepage the same answer only means "no manifest".
  const derived = (path: string) =>
    fetchAgentManifest({ url: `https://notes.test${path}`, fetch: localFetch, derived: true });
  expect(await derived("/404")).toEqual({ kind: "absent", status: 404 });
  expect(await derived("/410")).toEqual({ kind: "absent", status: 410 });
  expect(await get("/429")).toEqual({ kind: "unavailable", status: 429, retryAfter: "30" });
  expect(await get("/503")).toEqual({ kind: "unavailable", status: 503 });
  expect((await get("/403")).kind).toBe("invalid");
});

test("a document that is not a JSON manifest is invalid, with problems", async () => {
  handlers.set(
    "/html",
    () => new Response("<p>hi</p>", { headers: { "content-type": "text/html" } }),
  );
  handlers.set(
    "/bad-json",
    () => new Response("{", { headers: { "content-type": "application/json" } }),
  );
  handlers.set("/wrong", () => json({ schema: "nope" }));
  for (const path of ["/html", "/bad-json", "/wrong"]) {
    const outcome = await get(path);
    expect(outcome.kind).toBe("invalid");
    expect(outcome.kind === "invalid" && outcome.problems.length).toBeGreaterThan(0);
  }
});

test("a body over 1 MiB is refused by content-length and while streaming", async () => {
  const big = "x".repeat(1024 * 1024 + 1);
  handlers.set(
    "/big",
    () => new Response(big, { headers: { "content-type": "application/json" } }),
  );
  handlers.set(
    "/stream",
    () =>
      new Response(new ReadableStream({ pull: (c) => c.enqueue(new Uint8Array(64 * 1024)) }), {
        headers: { "content-type": "application/json" },
      }),
  );
  for (const path of ["/big", "/stream"]) {
    const outcome = await get(path);
    expect(outcome.kind === "invalid" && outcome.problems[0]?.message).toContain("1 MiB");
  }
});

test("redirects are followed, but never to http, to credentials or in a loop", async () => {
  handlers.set(
    "/to-m",
    () => new Response("", { status: 302, headers: { location: "https://notes.test/m.json" } }),
  );
  handlers.set(
    "/to-http",
    () => new Response("", { status: 302, headers: { location: "http://notes.test/m.json" } }),
  );
  handlers.set(
    "/to-cred",
    () => new Response("", { status: 302, headers: { location: "https://a:b@notes.test/m.json" } }),
  );
  handlers.set(
    "/loop",
    () => new Response("", { status: 302, headers: { location: "https://notes.test/loop" } }),
  );
  expect((await get("/to-m")).kind).toBe("valid");
  for (const path of ["/to-http", "/to-cred"]) {
    const outcome = await get(path);
    expect(outcome.kind === "unreachable" && outcome.message).toBe(
      "the manifest URL redirected to a non-https or credential-bearing URL",
    );
  }
  expect((await get("/loop")).kind).toBe("unreachable");
});

test("only https URLs without credentials are fetched", async () => {
  for (const url of ["http://notes.test/m.json", "https://a:b@notes.test/m.json", "nope"])
    expect((await fetchAgentManifest({ url, fetch: localFetch })).kind).toBe("unreachable");
});

test("a slow server and a refused connection are unreachable", async () => {
  handlers.set("/slow", async () => {
    await Bun.sleep(300);
    return json(MANIFEST);
  });
  expect((await get("/slow", { timeoutMs: 50 })).kind).toBe("unreachable");
  const refused = await fetchAgentManifest({
    url: "https://notes.test/m.json",
    fetch: () => Promise.reject(new TypeError("connect ECONNREFUSED")),
  });
  expect(refused).toMatchObject({ kind: "unreachable" });
});

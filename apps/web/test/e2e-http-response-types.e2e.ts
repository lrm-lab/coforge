import { expect, test } from "bun:test";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Response types after Start's production request/response wrapping. Requires a built local Web
 * served with the seeded development browser user, PostgreSQL and COFORGE_DEV_SKIP_AUTH=1.
 * Agent requests have no API keys and must remain unauthorized. The attachment id names no row.
 * Run with COFORGE_E2E_WEB_URL and a path: bun test ./test/e2e-http-response-types.e2e.ts.
 * Writes the observed HTTP contracts to .amp/e2e/http-response-types/responses.json.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/http-response-types");
const assets = join(import.meta.dir, "../.output/public/assets");

test("built HTTP routes preserve plain-text health and error responses", async () => {
  const cases = [
    { path: "/health", method: "GET", status: 200, body: "ok" },
    { path: "/api/agent/v1/workspace", method: "GET", status: 401, body: "unauthorized" },
    {
      path: "/api/agent/v1/github-credentials",
      method: "POST",
      status: 401,
      body: "unauthorized",
    },
    { path: "/api/agent/v1/channels", method: "POST", status: 401, body: "unauthorized" },
    {
      path: "/api/attachments/11111111-1111-4111-8111-111111111111",
      method: "GET",
      status: 404,
      body: "not found",
    },
  ];
  const observed = await Promise.all(
    cases.map(async (entry) => {
      const response = await fetch(`${origin}${entry.path}`, {
        method: entry.method,
        redirect: "manual",
      });
      return {
        path: entry.path,
        status: response.status,
        contentType: response.headers.get("content-type"),
        cacheControl: response.headers.get("cache-control"),
        body: await response.text(),
      };
    }),
  );
  await mkdir(artifacts, { recursive: true });
  await Bun.write(join(artifacts, "responses.json"), JSON.stringify(observed, null, 2));
  for (const [index, response] of observed.entries()) {
    expect(response.status, response.path).toBe(cases[index]!.status);
    expect(response.contentType, response.path).toContain("text/plain");
    expect(response.body, response.path).toBe(cases[index]!.body);
    if (response.path.startsWith("/api/agent/"))
      expect(response.cacheControl, response.path).toBe("no-store");
  }
});

test("explicit JSON and binary response types survive the same built server", async () => {
  const json = await fetch(`${origin}/api/jwks`);
  expect(json.status).toBe(200);
  expect(json.headers.get("content-type")).toContain("application/json");
  expect((await json.json()).keys).toBeArray();

  const font = (await readdir(assets)).find((name) => name.endsWith(".woff2"));
  if (!font) throw new Error("A production Web build with .woff2 assets is required");
  const binary = await fetch(`${origin}/assets/${font}`);
  expect(binary.status).toBe(200);
  expect(binary.headers.get("content-type")).toBe("font/woff2");
  expect(Buffer.from((await binary.bytes()).slice(0, 4)).toString()).toBe("wOF2");
});

import { expect, test } from "bun:test";
import {
  ArtifactSandbox,
  type SandboxDependencies,
} from "#src/server/artifacts/artifact-sandbox.server";
import { MemoryTicketNonces } from "#src/server/artifacts/artifact-sandbox-nonces.server";
import type { PublicPage } from "#src/server/artifacts/artifact-public-page.server";
import { encodeArtifactShortId } from "#src/features/artifacts/artifact-short-id";
import { PublicArtifactMissGuard } from "#src/server/artifacts/artifact-public-miss-guard.server";
import { FRAME } from "./helpers/artifact-sandbox-open";

const A = "11111111-1111-4111-8111-111111111111";
const BARE = "https://sandbox.example";
const ORIGIN = `https://a-${A}.sandbox.example`;
const APP = "https://app.example";
const TOKEN = "t".repeat(43);

const page = (access: string): PublicPage => ({
  workspaceId: "w1",
  artifactId: A,
  title: "Page",
  kind: "html",
  entryPath: "index.html",
  sha256: "sha",
  sizeBytes: 10,
  access,
  version: 3,
});

const sandbox = (
  lookup: (token: string) => Promise<PublicPage | null>,
  appOrigin: string | null = APP,
  options: Pick<SandboxDependencies, "missGuard" | "publicRateLimit"> = {},
) =>
  new ArtifactSandbox({
    reads: {} as never,
    readBlob: async () => new TextEncoder().encode("<!doctype html><p>hi</p>"),
    origin: BARE,
    nonces: new MemoryTicketNonces(),
    secret: async () => "s".repeat(40),
    now: () => new Date("2026-11-19T08:00:00Z"),
    publicPage: lookup,
    appOrigin: () => appOrigin,
    publicClientAddress: () => "192.0.2.1",
    ...options,
  });

test("an old public link to a link-tier artifact redirects to the artifact's public page", async () => {
  const response = await sandbox(async () => page("link")).serve(
    new Request(`${ORIGIN}/p/${TOKEN}`),
  );
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(`${APP}/a/${encodeArtifactShortId(A)}`);
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
});

test("a link-tier artifact's old content and file addresses no longer serve", async () => {
  const service = sandbox(async () => page("link"));
  for (const path of ["/page/index.html", "/file/index.html"])
    expect(
      (await service.serve(new Request(`${ORIGIN}/p/${TOKEN}${path}`, { headers: FRAME }))).status,
    ).toBe(404);
});

test("a revoked or unknown token is the same 404 as before", async () => {
  expect((await sandbox(async () => null).serve(new Request(`${ORIGIN}/p/${TOKEN}`))).status).toBe(
    404,
  );
});

test("a token on an artifact not yet moved to the link tier serves as it always did", async () => {
  const response = await sandbox(async () => page("conversation")).serve(
    new Request(`${ORIGIN}/p/${TOKEN}`),
  );
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(`/p/${TOKEN}/page/index.html`);
});

test("with no application origin configured the redirect is a 404, never a guess", async () => {
  expect(
    (await sandbox(async () => page("link"), null).serve(new Request(`${ORIGIN}/p/${TOKEN}`)))
      .status,
  ).toBe(404);
});

test.each(["link", "conversation", "workspace"])(
  "the bare origin redirects GET and HEAD for an old public token in the %s tier",
  async (access) => {
    const service = sandbox(async (token) => {
      expect(token).toBe(TOKEN);
      return page(access);
    });
    for (const method of ["GET", "HEAD"]) {
      const response = await service.serve(
        new Request(`${BARE}/p/${TOKEN}?target=https://other.example/`, { method }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`${APP}/a/${encodeArtifactShortId(A)}`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(await response.text()).toBe("");
    }
  },
);

test("bad token shapes, other bare paths and methods do not call the public lookup", async () => {
  let lookups = 0;
  const service = sandbox(async () => {
    lookups++;
    return page("conversation");
  });
  for (const path of ["/", "/l", "/p/bad", `/p/${TOKEN}/`, `/p/${TOKEN}/page/index.html`]) {
    expect((await service.serve(new Request(`${BARE}${path}`))).status).toBe(404);
  }
  expect((await service.serve(new Request(`${BARE}/p/${TOKEN}`, { method: "POST" }))).status).toBe(
    405,
  );
  expect(
    (await service.serve(new Request(`https://other.sandbox.example/p/${TOKEN}`))).status,
  ).toBe(404);
  expect(lookups).toBe(0);
});

test("the bare origin rate limits before lookup and records only valid-shaped misses", async () => {
  const events: string[] = [];
  const allowed = { allowed: true, retryAfterSeconds: 0 };
  let limited = true;
  let guarded = true;
  let found = false;
  const missGuard = new PublicArtifactMissGuard({
    perClient: {
      peek: async () => {
        events.push("guard");
        return guarded ? { allowed: false, retryAfterSeconds: 22 } : allowed;
      },
      admit: async () => {
        events.push("miss");
        return allowed;
      },
    },
    global: { admit: async () => allowed },
    now: () => 0,
  });
  const service = sandbox(
    async () => {
      events.push("lookup");
      return found ? page("conversation") : null;
    },
    APP,
    {
      missGuard,
      publicRateLimit: {
        admit: async () => {
          events.push("limit");
          return limited ? { allowed: false, retryAfterSeconds: 11 } : allowed;
        },
      },
    },
  );
  expect((await service.serve(new Request(`${BARE}/p/bad`))).status).toBe(404);
  expect(events.splice(0)).toEqual([]);
  const request = () => service.serve(new Request(`${BARE}/p/${TOKEN}`));
  const rateLimited = await request();
  expect(rateLimited.status).toBe(429);
  expect(rateLimited.headers.get("retry-after")).toBe("11");
  expect(events.splice(0)).toEqual(["limit"]);
  limited = false;
  const blocked = await request();
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get("retry-after")).toBe("22");
  expect(events.splice(0)).toEqual(["limit", "guard"]);
  guarded = false;
  const missing = await request();
  expect(missing.status).toBe(404);
  expect(missing.headers.get("location")).toBeNull();
  expect(events.splice(0)).toEqual(["limit", "guard", "lookup", "miss"]);
  found = true;
  expect((await request()).status).toBe(302);
  expect(events.splice(0)).toEqual(["limit", "guard", "lookup"]);
});

test("the bare token redirects only when a Web origin is configured", async () => {
  const service = sandbox(async () => page("conversation"), null);
  const response = await service.serve(new Request(`${BARE}/p/${TOKEN}`));
  expect(response.status).toBe(404);
  expect(response.headers.get("location")).toBeNull();
});

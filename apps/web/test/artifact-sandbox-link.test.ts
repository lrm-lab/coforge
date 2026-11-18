import { expect, test } from "bun:test";
import { ArtifactSandbox } from "#src/server/artifacts/artifact-sandbox.server";
import { MemoryTicketNonces } from "#src/server/artifacts/artifact-sandbox-nonces.server";
import { PublicArtifactMissGuard } from "#src/server/artifacts/artifact-public-miss-guard.server";
import type { PublicPage } from "#src/server/artifacts/artifact-public-page.server";
import type { PeekableRateLimit } from "#src/server/app-rate-limits/app-rate-limit.server";
import { FRAME } from "./helpers/artifact-sandbox-open";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ORIGIN = `https://a-${A}.sandbox.example`;
const PAGE = new TextEncoder().encode("<!doctype html><p>hi</p>");

const found: PublicPage = {
  workspaceId: "w1",
  artifactId: A,
  title: "Page",
  kind: "html",
  entryPath: "index.html",
  sha256: "sha",
  sizeBytes: 10,
};

function counter(limit: number): PeekableRateLimit {
  const counts = new Map<string, number>();
  return {
    async admit(id) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
      return counts.get(id)! <= limit
        ? { allowed: true }
        : { allowed: false, retryAfterSeconds: 30 };
    },
    async peek(id) {
      return (counts.get(id) ?? 0) < limit
        ? { allowed: true }
        : { allowed: false, retryAfterSeconds: 30 };
    },
  };
}

function linkSandbox(
  linkPage: ((artifactId: string, path?: string) => Promise<PublicPage | null>) | undefined,
  client = "192.0.2.1",
  missGuard = new PublicArtifactMissGuard({
    perClient: counter(20),
    global: counter(300),
    now: () => 0,
  }),
) {
  return new ArtifactSandbox({
    reads: {} as never,
    readBlob: async () => PAGE,
    origin: "https://sandbox.example",
    nonces: new MemoryTicketNonces(),
    secret: async () => "s".repeat(40),
    now: () => new Date("2026-11-19T08:00:00Z"),
    linkPage,
    missGuard,
    publicClientAddress: () => client,
  });
}

test("a link-tier page opens with no ticket and no reader, unframed, on its own artifact's origin", async () => {
  const service = linkSandbox(async (id) => (id === A ? found : null));
  const redirect = await service.serve(new Request(`${ORIGIN}/l`));
  expect(redirect.status).toBe(302);
  expect(redirect.headers.get("location")).toBe("/l/page/index.html");
  const shown = await service.serve(new Request(`${ORIGIN}/l/page/index.html`, { headers: FRAME }));
  expect(shown.status).toBe(200);
  expect(shown.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(shown.headers.get("referrer-policy")).toBe("no-referrer");
  for (const origin of [
    "https://sandbox.example",
    `https://a-${B}.sandbox.example`,
    "https://www.sandbox.example",
  ])
    expect((await service.serve(new Request(`${origin}/l`))).status, origin).toBe(404);
});

test("without a link lookup the route does not exist", async () => {
  expect((await linkSandbox(undefined).serve(new Request(`${ORIGIN}/l`))).status).toBe(404);
});

test("a miss is the same 404 whether the artifact is absent or not shared, and the 21st from one client is a 429", async () => {
  const service = linkSandbox(async () => null);
  for (let i = 0; i < 20; i++)
    expect((await service.serve(new Request(`${ORIGIN}/l`))).status).toBe(404);
  const refused = await service.serve(new Request(`${ORIGIN}/l`));
  expect(refused.status).toBe(429);
  expect(refused.headers.get("retry-after")).toBe("30");
});

test("another client still opens a page after one client is refused", async () => {
  const guard = new PublicArtifactMissGuard({
    perClient: counter(20),
    global: counter(300),
    now: () => 0,
  });
  const first = linkSandbox(async () => null, "192.0.2.1", guard);
  for (let i = 0; i < 21; i++) await first.serve(new Request(`${ORIGIN}/l`));
  expect((await first.serve(new Request(`${ORIGIN}/l`))).status).toBe(429);
  const second = linkSandbox(async () => found, "192.0.2.2", guard);
  expect((await second.serve(new Request(`${ORIGIN}/l`))).status).toBe(302);
});

test("the ticket path never consults the miss guard, so members are not counted", async () => {
  const guard = {
    refusal: () => {
      throw new Error("consulted");
    },
    miss: () => {
      throw new Error("consulted");
    },
  } as unknown as PublicArtifactMissGuard;
  const service = linkSandbox(async () => found, "192.0.2.1", guard);
  const bad = await service.serve(new Request(`${ORIGIN}/_coforge/open?ticket=nope`));
  expect(bad.status).toBe(404);
});

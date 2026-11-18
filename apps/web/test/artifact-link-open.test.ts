import { expect, test } from "bun:test";
import type { PeekableRateLimit } from "#src/server/app-rate-limits/app-rate-limit.server";
import { ArtifactLinkOpen } from "#src/server/artifacts/artifact-link-open.server";
import { PublicArtifactMissGuard } from "#src/server/artifacts/artifact-public-miss-guard.server";
import type { LinkLookup } from "#src/server/artifacts/artifact-public-page.server";

const A = "11111111-1111-4111-8111-111111111111";

const SHARED: LinkLookup = {
  shared: true,
  page: {
    workspaceId: "w1",
    artifactId: A,
    title: "Plan",
    kind: "html",
    entryPath: "index.html",
    sha256: "sha",
    sizeBytes: 10,
  },
};
const ABSENT: LinkLookup = { shared: false, page: null };

function counter(limit: number): PeekableRateLimit {
  const counts = new Map<string, number>();
  const refused = { allowed: false, retryAfterSeconds: 30 } as const;
  return {
    async admit(id) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
      return counts.get(id)! <= limit ? { allowed: true } : refused;
    },
    async peek(id) {
      return (counts.get(id) ?? 0) < limit ? { allowed: true } : refused;
    },
  };
}

const open = (limit = 1_000_000) => ({ admit: counter(limit).admit });

function opener(
  lookup: () => Promise<LinkLookup>,
  calls: string[] = [],
  limits: { perClient?: number; perArtifact?: number } = {},
) {
  return new ArtifactLinkOpen({
    perClient: open(limits.perClient),
    perArtifact: open(limits.perArtifact),
    lookup: async () => {
      calls.push("lookup");
      return lookup();
    },
    guard: new PublicArtifactMissGuard({
      perClient: counter(20),
      global: counter(300),
      now: () => 0,
    }),
    origin: "https://sandbox.example",
  });
}

test("a shared artifact opens for anyone: its title, kind and its own origin's address, no reader involved", async () => {
  expect(await opener(async () => SHARED).open({ artifactId: A, client: "192.0.2.1" })).toEqual({
    title: "Plan",
    kind: "html",
    url: `https://a-${A}.sandbox.example/l`,
  });
});

test("an absent and an unshared artifact are the same NOT_FOUND", async () => {
  for (const lookup of [ABSENT, { shared: true, page: null }])
    await expect(
      opener(async () => lookup).open({ artifactId: A, client: "192.0.2.1" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("the guard answers before the lookup runs: the 21st miss of a client is RATE_LIMITED with no query", async () => {
  const calls: string[] = [];
  const service = opener(async () => ABSENT, calls);
  for (let i = 0; i < 20; i++)
    await expect(service.open({ artifactId: A, client: "192.0.2.1" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  const before = calls.length;
  await expect(service.open({ artifactId: A, client: "192.0.2.1" })).rejects.toMatchObject({
    code: "RATE_LIMITED",
  });
  expect(calls.length).toBe(before);
  expect(
    await opener(async () => SHARED).open({ artifactId: A, client: "192.0.2.2" }),
  ).toBeTruthy();
});

test("a deployment with no sandbox origin cannot open it", async () => {
  const service = new ArtifactLinkOpen({
    perClient: open(),
    perArtifact: open(),
    lookup: async () => SHARED,
    guard: new PublicArtifactMissGuard({
      perClient: counter(20),
      global: counter(300),
      now: () => 0,
    }),
    origin: null,
  });
  await expect(service.open({ artifactId: A, client: "192.0.2.1" })).rejects.toMatchObject({
    code: "TEMPORARILY_UNAVAILABLE",
  });
});

test("a real shared artifact is still limited per client: the 121st open is RATE_LIMITED and queries nothing", async () => {
  const calls: string[] = [];
  const service = opener(async () => SHARED, calls, { perClient: 120 });
  for (let i = 0; i < 120; i++) await service.open({ artifactId: A, client: "192.0.2.1" });
  const before = calls.length;
  await expect(service.open({ artifactId: A, client: "192.0.2.1" })).rejects.toMatchObject({
    code: "RATE_LIMITED",
  });
  expect(calls.length).toBe(before);
  expect(await service.open({ artifactId: A, client: "192.0.2.2" })).toBeTruthy();
});

test("one artifact's anonymous opens are capped across all clients, and another artifact is not", async () => {
  const service = opener(async () => SHARED, [], { perArtifact: 600 });
  for (let i = 0; i < 600; i++) await service.open({ artifactId: A, client: `192.0.2.${i % 200}` });
  await expect(service.open({ artifactId: A, client: "198.51.100.1" })).rejects.toMatchObject({
    code: "RATE_LIMITED",
  });
  const other = "22222222-2222-4222-8222-222222222222";
  expect(await service.open({ artifactId: other, client: "198.51.100.1" })).toBeTruthy();
});

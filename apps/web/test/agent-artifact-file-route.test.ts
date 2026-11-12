import { afterAll, expect, test } from "bun:test";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";

const saved = { database: Bun.env.DATABASE_URL, redis: Bun.env.REDIS_URL };

afterAll(() => {
  for (const [name, value] of [
    ["DATABASE_URL", saved.database],
    ["REDIS_URL", saved.redis],
  ] as const)
    if (value === undefined) delete Bun.env[name];
    else Bun.env[name] = value;
});

// The download route's `:path` is one percent-encoded segment (the SDK builds it with
// `encodeURIComponent`). The router must hand the handler exactly the file path the client named:
// `%2F` is part of the segment, and nothing is decoded twice.
test("the file download route receives the path as the client named it", async () => {
  Bun.env.DATABASE_URL = "postgresql://coforge:coforge@127.0.0.1:1/unused";
  delete Bun.env.REDIS_URL;
  const { getRouter } = await import("#src/router");
  const router = getRouter();
  // As the server reads a request's URL: only `href` is parsed.
  const pathnameOf = (href: string) =>
    router.parseLocation({ href, pathname: "", search: "", hash: "", state: { __TSR_index: 0 } })
      .pathname;
  for (const path of [
    "css/site.css",
    "weird name #1 100%.md",
    "ünï.txt",
    "a%2Fb",
    "a%41.md",
    "q?x=1&y.md",
    "back\\slash.txt",
    "a+b.md",
    "日本語 ファイル.md",
  ]) {
    const href = agentApiRoutes.cloud.artifactFiles.download.path("abc", path);
    const [, params, route] = router.getMatchedRoutes(pathnameOf(href));
    expect(route?.id).toBe("/api/agent/v1/artifacts_/$artifact/files/$path");
    expect(params).toMatchObject({ artifact: "abc", path });
  }
  const upload = agentApiRoutes.cloud.artifactFiles.upload.path("a".repeat(64));
  const [, params, route] = router.getMatchedRoutes(pathnameOf(upload));
  expect(route?.id).toBe("/api/agent/v1/artifacts_/uploads/$sha256");
  expect(params).toMatchObject({ sha256: "a".repeat(64) });
});

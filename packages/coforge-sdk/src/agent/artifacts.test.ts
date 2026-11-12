import { expect, test } from "bun:test";
import {
  ARTIFACT_SHA256_PATTERN,
  artifactPathValid,
  decodeAgentArtifactRequest,
} from "./artifacts";
import { agentApiRoutes } from "./routes";

test("an artifact request is one known operation with exactly its own fields", () => {
  expect(
    decodeAgentArtifactRequest({ operation: "create", title: "Plan", target: "#launch" }),
  ).toEqual({ operation: "create", title: "Plan", target: "#launch" });
  expect(
    decodeAgentArtifactRequest({ operation: "create", title: "Plan", idempotencyKey: "k1" }),
  ).toEqual({ operation: "create", title: "Plan", idempotencyKey: "k1" });
  expect(decodeAgentArtifactRequest({ operation: "list" })).toEqual({ operation: "list" });
  expect(decodeAgentArtifactRequest({ operation: "list", target: "#launch" })).toEqual({
    operation: "list",
    target: "#launch",
  });
  expect(
    decodeAgentArtifactRequest({
      operation: "push",
      artifact: "a1",
      baseVersion: 2,
      idempotencyKey: "k",
      text: "# Plan\n",
    }),
  ).toMatchObject({ operation: "push", baseVersion: 2 });
  // A save's internal options, an unknown operation, a missing field, a wrong type: refused.
  for (const body of [
    { operation: "push", artifact: "a1", baseVersion: 2, idempotencyKey: "k", exactBase: true },
    {
      operation: "revert",
      artifact: "a1",
      to: 1,
      baseVersion: 2,
      idempotencyKey: "k",
      revertedFrom: 1,
    },
    { operation: "delete", artifact: "a1" },
    { operation: "read" },
    { operation: "read", artifact: "a1", version: -1 },
    { operation: "read", artifact: 7 },
    ["read"],
    null,
  ])
    expect(decodeAgentArtifactRequest(body)).toBeNull();

  expect(
    decodeAgentArtifactRequest({
      operation: "share",
      artifactIds: ["a", "b"],
      targets: ["#launch", "@ada"],
      note: "Read this",
      requestId: "request-1",
    }),
  ).toEqual({
    operation: "share",
    artifactIds: ["a", "b"],
    targets: ["#launch", "@ada"],
    note: "Read this",
    requestId: "request-1",
  });
  expect(
    decodeAgentArtifactRequest({
      operation: "share",
      artifactIds: ["a", 1],
      targets: ["#launch"],
      requestId: "request-1",
    }),
  ).toBeNull();
});

test("the artifacts route is the same under proxy, local and cloud, with room for a document", () => {
  for (const routes of [agentApiRoutes.proxy, agentApiRoutes.local, agentApiRoutes.cloud])
    expect(routes.artifacts).toMatchObject({ method: "POST", path: "/api/agent/v1/artifacts" });
  expect(agentApiRoutes.proxy.artifacts.maxBodyBytes).toBeGreaterThan(4 * 1024 * 1024);
});

test("a create or push may carry a file manifest instead of text", () => {
  expect(
    decodeAgentArtifactRequest({
      operation: "push",
      artifact: "a1",
      baseVersion: 3,
      idempotencyKey: "k",
      files: [{ path: "index.html", sha256: "a".repeat(64) }],
      delete: ["old.css"],
      entry: "index.html",
    }),
  ).toEqual({
    operation: "push",
    artifact: "a1",
    baseVersion: 3,
    idempotencyKey: "k",
    files: [{ path: "index.html", sha256: "a".repeat(64) }],
    delete: ["old.css"],
    entry: "index.html",
  });
  expect(
    decodeAgentArtifactRequest({
      operation: "create",
      title: "Funnel",
      files: [{ path: "report.md", sha256: "b".repeat(64) }],
      entry: "report.md",
    }),
  ).toMatchObject({ operation: "create", entry: "report.md" });
  // A manifest entry is exactly a path and a lowercase sha256.
  for (const files of [
    [{ path: "a.md" }],
    [{ path: "a.md", sha256: "A".repeat(64) }],
    [{ path: "a.md", sha256: "a".repeat(63) }],
    [{ path: "a.md", sha256: "a".repeat(64), size: 3 }],
    ["a.md"],
    { path: "a.md", sha256: "a".repeat(64) },
  ])
    expect(
      decodeAgentArtifactRequest({
        operation: "push",
        artifact: "a1",
        baseVersion: 1,
        idempotencyKey: "k",
        files,
      }),
    ).toBeNull();
  // Text and a manifest are two ways to send one version, never both.
  expect(
    decodeAgentArtifactRequest({
      operation: "push",
      artifact: "a1",
      baseVersion: 1,
      idempotencyKey: "k",
      text: "x",
      files: [],
    }),
  ).toBeNull();
});

test("list may search titles and page", () => {
  expect(
    decodeAgentArtifactRequest({ operation: "list", query: "funnel", after: "c1", limit: 20 }),
  ).toEqual({ operation: "list", query: "funnel", after: "c1", limit: 20 });
});

test("file bytes go up and come down on their own routes", () => {
  const sha = "c".repeat(64);
  for (const side of ["local", "cloud"] as const) {
    const routes = agentApiRoutes[side].artifactFiles;
    expect(routes.upload.method).toBe("PUT");
    expect(routes.upload.path(sha)).toBe(`/api/agent/v1/artifacts/uploads/${sha}`);
    expect(routes.download.method).toBe("GET");
    expect(routes.download.path("a1", "css/site.css")).toBe(
      "/api/agent/v1/artifacts/a1/files/css%2Fsite.css",
    );
  }
});

test("an artifact file path is relative plain segments, and a sha256 is lowercase hex", () => {
  for (const path of ["index.html", "css/site.css", "a..b.txt", "docs/v1.2/notes.md"])
    expect(artifactPathValid(path)).toBe(true);
  for (const path of ["", "/abs", "dir/", "a//b", "./a", "a/../b", "a\\b", "c:x", "a\u0000b"])
    expect(artifactPathValid(path)).toBe(false);
  expect(ARTIFACT_SHA256_PATTERN.test("a".repeat(64))).toBe(true);
  expect(ARTIFACT_SHA256_PATTERN.test("A".repeat(64))).toBe(false);
});

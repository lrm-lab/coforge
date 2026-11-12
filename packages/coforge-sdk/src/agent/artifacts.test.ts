import { expect, test } from "bun:test";
import {
  ARTIFACT_SHA256_PATTERN,
  artifactOperationTraits,
  artifactPathValid,
  decodeAgentArtifactRequest,
  type AgentArtifactRequest,
} from "./artifacts";
import { agentApiRoutes } from "./routes";

const FILE = { path: "report.md", sha256: "b".repeat(64) };

test("an artifact request is one known operation with exactly its own fields", () => {
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
      title: "Plan",
    }),
  ).toMatchObject({ operation: "push", baseVersion: 2 });
  // A save's internal options, a removed operation, an unknown one, a missing field, a wrong type:
  // refused.
  for (const body of [
    { operation: "push", artifact: "a1", baseVersion: 2, idempotencyKey: "k", exactBase: true },
    { operation: "push", artifact: "a1", baseVersion: 2, idempotencyKey: "k", text: "# Plan\n" },
    { operation: "create", title: "Plan", idempotencyKey: "k", files: [FILE] },
    { operation: "history", artifact: "a1" },
    { operation: "revert", artifact: "a1", to: 1, baseVersion: 2, idempotencyKey: "k" },
    { operation: "share", artifactIds: ["a"], targets: ["#launch"], requestId: "r" },
    { operation: "delete", artifact: "a1" },
    { operation: "read" },
    { operation: "read", artifact: "a1", version: -1 },
    { operation: "read", artifact: 7 },
    ["read"],
    null,
  ])
    expect(decodeAgentArtifactRequest(body)).toBeNull();
});

test("the artifacts route is the same under proxy, local and cloud, with room for a manifest", () => {
  for (const routes of [agentApiRoutes.proxy, agentApiRoutes.local, agentApiRoutes.cloud])
    expect(routes.artifacts).toMatchObject({ method: "POST", path: "/api/agent/v1/artifacts" });
  // 200 files at the longest path, JSON-escaped, fit with room to spare.
  expect(agentApiRoutes.proxy.artifacts.maxBodyBytes).toBeGreaterThan(200 * (1024 * 6 + 100));
});

test("a push carries a file manifest", () => {
  const over: AgentArtifactRequest = {
    operation: "push",
    artifact: "a1",
    baseVersion: 3,
    idempotencyKey: "k",
    files: [{ path: "index.html", sha256: "a".repeat(64) }],
    delete: ["old.css"],
    entry: "index.html",
  };
  expect(decodeAgentArtifactRequest(over)).toEqual(over);
  // A manifest entry is exactly a path and a lowercase sha256.
  for (const files of [
    [{ path: "a.md" }],
    [{ path: "a.md", sha256: "A".repeat(64) }],
    [{ path: "a.md", sha256: "a".repeat(63) }],
    [{ path: "a.md", sha256: "a".repeat(64), size: 3 }],
    ["a.md"],
    { path: "a.md", sha256: "a".repeat(64) },
  ])
    expect(decodeAgentArtifactRequest({ ...over, files })).toBeNull();
});

test("a push with no artifact makes one: a title, files and a target, and no base", () => {
  const made: AgentArtifactRequest = {
    operation: "push",
    title: "Funnel",
    target: "#launch",
    description: "Weekly funnel",
    idempotencyKey: "k",
    files: [FILE],
    entry: "report.md",
  };
  expect(decodeAgentArtifactRequest(made)).toEqual(made);
  // It needs a title and files, and takes nothing that only a push over a version has.
  for (const body of [
    { ...made, title: undefined },
    { ...made, files: undefined },
    { ...made, baseVersion: 0 },
    { ...made, note: "n" },
    { ...made, label: "l" },
    { ...made, delete: ["a.md"] },
  ])
    expect(decodeAgentArtifactRequest(body)).toBeNull();
  // A push over an artifact needs its base and has no target.
  const over: AgentArtifactRequest = {
    operation: "push",
    artifact: "a1",
    baseVersion: 1,
    idempotencyKey: "k",
  };
  expect(decodeAgentArtifactRequest(over)).toEqual(over);
  for (const body of [
    { ...over, baseVersion: undefined },
    { ...over, target: "#launch" },
  ])
    expect(decodeAgentArtifactRequest(body)).toBeNull();
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

test("the comment operations take exactly their own fields, nested ones included", () => {
  expect(
    decodeAgentArtifactRequest({
      operation: "comments",
      artifact: "a1",
      path: "plan.md",
      all: true,
      review: "r1",
      after: "c",
    }),
  ).toEqual({
    operation: "comments",
    artifact: "a1",
    path: "plan.md",
    all: true,
    review: "r1",
    after: "c",
  });
  expect(decodeAgentArtifactRequest({ operation: "comments", artifact: "a1" })).toEqual({
    operation: "comments",
    artifact: "a1",
  });
  const comment: AgentArtifactRequest = {
    operation: "comment",
    artifact: "a1",
    body: "Too long.",
    path: "plan.md",
    anchor: { type: "lines", data: { start: 3, end: 4 } },
    replyTo: "c1",
    version: 2,
    idempotencyKey: "k",
  };
  expect(decodeAgentArtifactRequest(comment)).toEqual(comment);
  const review: AgentArtifactRequest = {
    operation: "review",
    artifact: "a1",
    body: "Summary",
    comments: [{ body: "One" }, { body: "Two", path: "a.md", anchor: { type: "file", data: {} } }],
    idempotencyKey: "k",
  };
  expect(decodeAgentArtifactRequest(review)).toEqual(review);
  expect(
    decodeAgentArtifactRequest({
      operation: "resolve",
      artifact: "a1",
      comment: "c1",
      note: "Done",
    }),
  ).toEqual({ operation: "resolve", artifact: "a1", comment: "c1", note: "Done" });
  expect(
    decodeAgentArtifactRequest({ operation: "reopen", artifact: "a1", comment: "c1" }),
  ).toEqual({
    operation: "reopen",
    artifact: "a1",
    comment: "c1",
  });
});

test("a comment request with a stray, missing or mistyped field is refused", () => {
  const base = { operation: "comment", artifact: "a1", body: "x", idempotencyKey: "k" };
  for (const body of [
    { ...base, body: undefined },
    { ...base, idempotencyKey: undefined },
    { ...base, anchor: "lines" },
    { ...base, anchor: { type: "lines" } },
    { ...base, anchor: { type: "lines", data: [] } },
    { ...base, anchor: { type: "lines", data: {}, extra: 1 } },
    { ...base, anchor: { type: 7, data: {} } },
    { ...base, anchor: { type: "wiggle", data: {} } },
    { ...base, version: "2" },
    { ...base, authorAgentId: "someone" },
    { operation: "comments", artifact: "a1", all: "yes" },
    { operation: "comments", artifact: "a1", exact: true },
    { operation: "resolve", artifact: "a1" },
    { operation: "reopen", artifact: "a1", comment: "c1", note: "no note here" },
    { operation: "review", artifact: "a1", idempotencyKey: "k" },
    { operation: "review", artifact: "a1", idempotencyKey: "k", comments: "x" },
    { operation: "review", artifact: "a1", idempotencyKey: "k", comments: ["x"] },
    { operation: "review", artifact: "a1", idempotencyKey: "k", comments: [{ path: "a.md" }] },
    {
      operation: "review",
      artifact: "a1",
      idempotencyKey: "k",
      comments: [{ body: "x", authorUserId: "u" }],
    },
    {
      operation: "review",
      artifact: "a1",
      idempotencyKey: "k",
      comments: [{ body: "x", anchor: { type: "text", data: {}, extra: true } }],
    },
  ])
    expect(decodeAgentArtifactRequest(body)).toBeNull();
});

test("each operation says whether it reads, is held up by unseen comments, or writes a comment", () => {
  const traits = (operation: AgentArtifactRequest["operation"]) =>
    artifactOperationTraits(operation);
  for (const operation of ["list", "read", "comments"] as const)
    expect(traits(operation)).toEqual({
      readOnly: true,
      gatedByComments: false,
      commentWrite: false,
    });
  for (const operation of ["push", "comment", "review"] as const)
    expect(traits(operation).gatedByComments).toBe(true);
  for (const operation of ["comment", "review", "resolve", "reopen"] as const)
    expect(traits(operation)).toMatchObject({ readOnly: false, commentWrite: true });
  expect(traits("push")).toMatchObject({ readOnly: false, commentWrite: false });
});

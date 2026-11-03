import { expect, test } from "bun:test";
import { decodeAgentArtifactRequest } from "./artifacts";
import { agentApiRoutes } from "./routes";

test("an artifact request is one known operation with exactly its own fields", () => {
  expect(
    decodeAgentArtifactRequest({ operation: "create", title: "Plan", target: "#launch" }),
  ).toEqual({ operation: "create", title: "Plan", target: "#launch" });
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
});

test("the artifacts route is the same under proxy, local and cloud, with room for a document", () => {
  for (const routes of [agentApiRoutes.proxy, agentApiRoutes.local, agentApiRoutes.cloud])
    expect(routes.artifacts).toMatchObject({ method: "POST", path: "/api/agent/v1/artifacts" });
  expect(agentApiRoutes.proxy.artifacts.maxBodyBytes).toBeGreaterThan(4 * 1024 * 1024);
});

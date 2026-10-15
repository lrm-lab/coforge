import { afterEach, expect, test } from "bun:test";
import { AgentMigrationHttpClient } from "#src/connection/agent-migration-http-client";
import { AgentMigrationRemoteError } from "#src/agent-migration/transfer-ports";

const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function route(answer: (body: Record<string, unknown>) => Response) {
  const seen: {
    method: string;
    path: string;
    authorization: string | null;
    body: Record<string, unknown>;
  }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        body,
      });
      return answer(body);
    },
  });
  servers.push(server);
  const client = new AgentMigrationHttpClient({
    endpoint: () => `http://127.0.0.1:${server.port}/api/daemon/agent-migrations`,
    daemonApiKey: () => "daemon-key",
  });
  return { client, seen };
}

const ids = { migrationId: "migration-1", generation: 1 };

test("each operation is one POST with the daemon key, its name and its fields", async () => {
  const { client, seen } = route((body) => {
    switch (body.operation) {
      case "view":
        return Response.json({
          migration: {
            id: "migration-1",
            agentId: "agent-1",
            role: "target",
            state: "uploaded",
            generation: 1,
            revision: 2,
            sourceComputerId: "computer-a",
            targetComputerId: "computer-b",
          },
          manifest: null,
        });
      case "upload_url":
        return Response.json({
          url: "https://oss.test/put",
          headers: { "x-oss-forbid-overwrite": "true" },
        });
      case "download_url":
        return Response.json({ url: "https://oss.test/get" });
      default:
        return Response.json({
          status: "advanced",
          migration: { id: "migration-1", state: "placing", generation: 1, revision: 3 },
        });
    }
  });
  expect(await client.view("migration-1")).toMatchObject({
    migration: { role: "target", state: "uploaded", revision: 2 },
    manifest: null,
  });
  expect(
    await client.uploadUrl({
      ...ids,
      chunk: { index: 0, offsetBytes: 0, sizeBytes: 1, sha256: "a".repeat(64) },
    }),
  ).toEqual({ url: "https://oss.test/put", headers: { "x-oss-forbid-overwrite": "true" } });
  expect(await client.downloadUrl({ ...ids, index: 4 })).toEqual({ url: "https://oss.test/get" });
  expect(
    await client.step({ ...ids, expectedRevision: 2, step: "placement_started" }),
  ).toMatchObject({ status: "advanced", migration: { state: "placing", revision: 3 } });
  await client.fail({ ...ids, errorCode: "download_failed", errorDetail: "chunk 4" });
  const manifest = { sha256: "b".repeat(64), sizeBytes: 1, chunks: [] } as never;
  await client.completeUpload({ ...ids, expectedRevision: 1, manifest });
  expect(
    new Set(seen.map(({ method, path, authorization }) => `${method} ${path} ${authorization}`)),
  ).toEqual(new Set(["POST /api/daemon/agent-migrations Bearer daemon-key"]));
  expect(seen.map((request) => request.body)).toEqual([
    { operation: "view", migrationId: "migration-1" },
    {
      operation: "upload_url",
      ...ids,
      chunk: { index: 0, offsetBytes: 0, sizeBytes: 1, sha256: "a".repeat(64) },
    },
    { operation: "download_url", ...ids, index: 4 },
    { operation: "step", ...ids, expectedRevision: 2, step: "placement_started" },
    { operation: "fail", ...ids, errorCode: "download_failed", errorDetail: "chunk 4" },
    { operation: "upload_complete", ...ids, expectedRevision: 1, manifest },
  ]);
});

test("a refusal carries the route's status and code; only transient ones are retryable", async () => {
  let status = 409;
  const { client } = route(() => Response.json({ error: "stale_revision" }, { status }));
  const refused = await client.view("migration-1").catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(AgentMigrationRemoteError);
  expect(refused).toMatchObject({ code: "stale_revision", retryable: false });
  status = 503;
  expect(await client.view("migration-1").catch((error: unknown) => error)).toMatchObject({
    code: "stale_revision",
    retryable: true,
  });
});

test("a deployment without a migration bucket is refused for good, not retried", async () => {
  const { client } = route(() => Response.json({ error: "unavailable" }, { status: 503 }));
  expect(await client.view("migration-1").catch((error: unknown) => error)).toMatchObject({
    code: "unavailable",
    retryable: false,
  });
});

test("a failure report fits the route: its detail is cut to the route's limit", async () => {
  const { client, seen } = route(() =>
    Response.json({
      status: "failed",
      migration: { id: "migration-1", state: "failed", generation: 1, revision: 4 },
    }),
  );
  await client.fail({ ...ids, errorCode: "download_failed", errorDetail: "x".repeat(5000) });
  expect((seen[0]!.body.errorDetail as string).length).toBe(2000);
});

test("an unreachable server is a retryable failure, not a refusal", async () => {
  const client = new AgentMigrationHttpClient({
    endpoint: () => "http://127.0.0.1:1/api/daemon/agent-migrations",
    daemonApiKey: () => "daemon-key",
  });
  expect(await client.view("migration-1").catch((error: unknown) => error)).toMatchObject({
    code: "network",
    retryable: true,
  });
});

test("an answer that is not the shape the route sends is refused, not trusted", async () => {
  const { client } = route((body) =>
    body.operation === "view"
      ? Response.json({ migration: { id: "migration-1", role: "bystander" }, manifest: null })
      : body.operation === "download_url"
        ? Response.json({ url: 7 })
        : Response.json({ status: "advanced", migration: { state: "placing" } }),
  );
  for (const call of [
    () => client.view("migration-1"),
    () => client.downloadUrl({ ...ids, index: 0 }),
    () => client.step({ ...ids, expectedRevision: 0, step: "arrived" }),
  ])
    expect(await call().catch((error: unknown) => error)).toMatchObject({
      code: "invalid_response",
      retryable: false,
    });
});

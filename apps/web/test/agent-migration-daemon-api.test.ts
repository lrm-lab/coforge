import { expect, test } from "bun:test";
import { AgentMigrations } from "#src/server/agent-migrations/agent-migrations.server";
import { AgentMigrationTransport } from "#src/server/agent-migrations/agent-migration-transport.server";
import {
  agentMigrationDaemonRequestSchema,
  answerAgentMigrationDaemonRequest,
} from "#src/server/agent-migrations/agent-migration-daemon-api.server";
import { memoryStore } from "./helpers/agent-migration-memory-store";

const workspaceId = "workspace-1";
const source = { workspaceId, computerId: "computer-a" };
const target = { workspaceId, computerId: "computer-b" };

async function setup() {
  const migrations = new AgentMigrations(memoryStore().store);
  const created = await migrations.request({
    workspaceId,
    agentId: "agent-1",
    targetComputerId: "computer-b",
    requestedByUserId: "user-1",
  });
  if (created.status !== "created") throw new Error(created.status);
  const transport = new AgentMigrationTransport(migrations, {
    head: async () => null,
    presignPut: async (key) => ({ url: `https://oss.test/${key}`, headers: {} }),
    presignGet: async (key) => `https://oss.test/${key}`,
  });
  const answer = (participant: typeof source, body: unknown) => {
    const input = agentMigrationDaemonRequestSchema.safeParse(body);
    if (!input.success) throw new Error("request did not parse");
    return answerAgentMigrationDaemonRequest(transport, participant, input.data);
  };
  return { id: created.migration.id, answer };
}

test("a daemon views, steps and fails a migration through one HTTPS operation", async () => {
  const { id, answer } = await setup();
  const viewed = await answer(source, { operation: "view", migrationId: id });
  expect(viewed).toMatchObject({
    status: 200,
    body: { migration: { role: "source", revision: 0 } },
  });
  expect(
    await answer(source, {
      operation: "step",
      migrationId: id,
      generation: 1,
      expectedRevision: 0,
      step: "source_stopped",
    }),
  ).toMatchObject({ status: 200, body: { migration: { state: "source_stopped" } } });
  expect(
    await answer(source, {
      operation: "upload_url",
      migrationId: id,
      generation: 1,
      chunk: { index: 0, offsetBytes: 0, sizeBytes: 8, sha256: "0".repeat(64) },
    }),
  ).toMatchObject({ status: 200, body: { url: expect.stringContaining("/chunks/0-") } });
  expect(
    await answer(target, { operation: "download_url", migrationId: id, generation: 1, index: 0 }),
  ).toEqual({ status: 409, body: { error: "invalid_state" } });
  expect(
    await answer(target, {
      operation: "fail",
      migrationId: id,
      generation: 1,
      errorCode: "download_failed",
    }),
  ).toMatchObject({ status: 200, body: { migration: { state: "failed" } } });
});

test("refusals map to HTTP statuses a daemon can act on, never to a 200", async () => {
  const { id, answer } = await setup();
  expect(await answer(target, { operation: "view", migrationId: "missing" })).toEqual({
    status: 404,
    body: { error: "not_found" },
  });
  expect(
    await answer(target, {
      operation: "step",
      migrationId: id,
      generation: 1,
      expectedRevision: 0,
      step: "source_stopped",
    }),
  ).toEqual({ status: 409, body: { error: "wrong_computer" } });
  expect(
    await answer(source, {
      operation: "upload_complete",
      migrationId: id,
      generation: 1,
      expectedRevision: 0,
      manifest: { format: "zip" },
    }),
  ).toEqual({ status: 422, body: { error: "invalid_manifest" } });
});

test("the request schema refuses upload_complete as a plain step and unknown operations", () => {
  const base = { migrationId: "m", generation: 1, expectedRevision: 0 };
  expect(
    agentMigrationDaemonRequestSchema.safeParse({
      ...base,
      operation: "step",
      step: "upload_complete",
    }).success,
  ).toBe(false);
  expect(
    agentMigrationDaemonRequestSchema.safeParse({ ...base, operation: "cancel" }).success,
  ).toBe(false);
});

import { expect, test } from "bun:test";
import { decodeAgentMigrationCancel, decodeAgentMigrationLease } from "@lrm/coforge-sdk/internal";
import { AgentMigrations } from "#src/server/agent-migrations/agent-migrations.server";
import {
  AGENT_MIGRATION_LEASE_MS,
  AgentMigrationDispatch,
} from "#src/server/agent-migrations/agent-migration-dispatch.server";
import { AgentMigrationOrchestrator } from "#src/server/agent-migrations/agent-migration-orchestrator.server";
import { memoryStore } from "./helpers/agent-migration-memory-store";

const workspaceId = "workspace-1";
const source = { workspaceId, computerId: "computer-a" };
const target = { workspaceId, computerId: "computer-b" };

function setup(
  options: { stoppedByUser?: boolean; stopFails?: boolean; publishFails?: boolean } = {},
) {
  const fixture = memoryStore();
  const migrations = new AgentMigrations(fixture.store);
  const published: { channel: string; data: Uint8Array }[] = [];
  const runtime: string[] = [];
  /** Cancels published and Agents started, in the order they went out. */
  const order: string[] = [];
  /** The bucket prefixes removed once a migration ended. */
  const removed: string[] = [];
  const orchestrator = new AgentMigrationOrchestrator({
    migrations,
    dispatch: new AgentMigrationDispatch({
      publish: async (channel, data) => {
        published.push({ channel, data });
        try {
          order.push(`cancel:${decodeAgentMigrationCancel(data).role}`);
        } catch {}
        if (options.publishFails) throw new Error("centrifugo is unreachable");
      },
    }),
    runtime: {
      stoppedByUser: async () => options.stoppedByUser ?? false,
      stop: async (agent) => {
        runtime.push(`stop:${agent.agentId}`);
        if (options.stopFails) throw new Error("the source did not confirm the stop");
      },
      start: async (agent) => {
        // As Agent control does: nothing starts an Agent a migration still holds.
        if (
          [...fixture.rows.values()].some(
            (row) =>
              row.agentId === agent.agentId &&
              ["requested", "source_stopped", "uploaded", "placing"].includes(row.state),
          )
        )
          throw new Error("agent-migrating");
        runtime.push(`start:${agent.agentId}@${fixture.agentComputer.value}`);
        order.push("start");
      },
    },
    lock: { run: (_agentId, callback) => callback() },
    bucket: async () => ({
      removePrefix: async (prefix: string) => {
        removed.push(prefix);
      },
    }),
  });
  const request = {
    workspaceId,
    agentId: "agent-1",
    targetComputerId: "computer-b",
    requestedByUserId: "user-1",
  };
  const leases = () =>
    published
      .map((entry) => {
        try {
          return decodeAgentMigrationLease(entry.data);
        } catch {
          return null;
        }
      })
      .filter((lease) => lease !== null);
  const cancels = () =>
    published
      .map((entry) => {
        try {
          return decodeAgentMigrationCancel(entry.data);
        } catch {
          return null;
        }
      })
      .filter((cancel) => cancel !== null);
  return {
    ...fixture,
    migrations,
    orchestrator,
    runtime,
    order,
    removed,
    request,
    leases,
    cancels,
  };
}

async function upToPlacing(context: ReturnType<typeof setup>, id: string) {
  const { migrations } = context;
  await migrations.advance(source, {
    migrationId: id,
    generation: 1,
    expectedRevision: 0,
    step: "source_stopped",
  });
  await migrations.advance(source, {
    migrationId: id,
    generation: 1,
    expectedRevision: 1,
    step: "upload_complete",
    manifest: {},
  });
  await migrations.advance(target, {
    migrationId: id,
    generation: 1,
    expectedRevision: 2,
    step: "placement_started",
  });
}

test("a request stops the Agent through its control before the source is leased", async () => {
  const context = setup();
  const started = await context.orchestrator.request(context.request);
  if (started.status !== "created") throw new Error(started.status);
  expect(context.runtime).toEqual(["stop:agent-1"]);
  expect(context.leases()).toMatchObject([{ role: "source", computerId: "computer-a" }]);
});

test("an Agent its owner had stopped is not stopped again, and stays stopped where it lands", async () => {
  const context = setup({ stoppedByUser: true });
  const started = await context.orchestrator.request(context.request);
  if (started.status !== "created") throw new Error(started.status);
  await upToPlacing(context, started.migration.id);
  const switched = await context.migrations.advance(target, {
    migrationId: started.migration.id,
    generation: 1,
    expectedRevision: 3,
    step: "switch",
  });
  if (switched.status !== "advanced") throw new Error(switched.status);
  await context.orchestrator.switched(switched.migration);
  expect(context.runtime).toEqual([]);
  expect(context.rows.get(started.migration.id)!.state).toBe("completed");
});

test("a source that cannot confirm the stop ends the migration before anything moves", async () => {
  const context = setup({ stopFails: true });
  await expect(context.orchestrator.request(context.request)).rejects.toThrow("did not confirm");
  // The stop is superseded at once, so the Agent does not stay stopped on the source.
  expect(context.runtime).toEqual(["stop:agent-1", "start:agent-1@computer-a"]);
  const [row] = [...context.rows.values()];
  expect(row!.state).toBe("canceled");
  expect(context.leases()).toEqual([]);
});

test("after the switch the Agent starts on the target and the migration completes", async () => {
  const context = setup();
  const started = await context.orchestrator.request(context.request);
  if (started.status !== "created") throw new Error(started.status);
  await upToPlacing(context, started.migration.id);
  const switched = await context.migrations.advance(target, {
    migrationId: started.migration.id,
    generation: 1,
    expectedRevision: 3,
    step: "switch",
  });
  if (switched.status !== "advanced") throw new Error(switched.status);
  await context.orchestrator.switched(switched.migration);
  expect(context.runtime).toEqual(["stop:agent-1", "start:agent-1@computer-b"]);
  expect(context.rows.get(started.migration.id)!.state).toBe("completed");
});

test("a failure before the switch tells both Computers and starts the Agent again on the source", async () => {
  const context = setup();
  const started = await context.orchestrator.request(context.request);
  if (started.status !== "created") throw new Error(started.status);
  const failed = await context.migrations.fail(target, {
    migrationId: started.migration.id,
    generation: 1,
    errorCode: "download_failed",
  });
  if (failed.status !== "failed") throw new Error(failed.status);
  await context.orchestrator.ended(failed.migration);
  expect(context.cancels()).toMatchObject([
    { role: "source", switched: false },
    { role: "target", switched: false },
  ]);
  expect(context.runtime).toEqual(["stop:agent-1", "start:agent-1@computer-a"]);
});

test("a user's cancel before the switch ends the migration the same way", async () => {
  const context = setup();
  const started = await context.orchestrator.request(context.request);
  if (started.status !== "created") throw new Error(started.status);
  expect(
    await context.orchestrator.cancel({ workspaceId, migrationId: started.migration.id }),
  ).toMatchObject({ status: "canceled" });
  expect(context.cancels()).toHaveLength(2);
  expect(context.runtime.at(-1)).toBe("start:agent-1@computer-a");
});

test("the source restart does not wait on telling the Computers, and happens again on a retry", async () => {
  const context = setup({ publishFails: true });
  const created = await context.migrations.request(context.request);
  if (created.status !== "created") throw new Error(created.status);
  const failed = await context.migrations.fail(target, {
    migrationId: created.migration.id,
    generation: 1,
    errorCode: "download_failed",
  });
  if (failed.status !== "failed") throw new Error(failed.status);
  await expect(context.orchestrator.ended(failed.migration)).rejects.toThrow("unreachable");
  expect(context.runtime).toEqual(["start:agent-1@computer-a"]);
  // A daemon retrying its report finds the migration already failed and ends it again.
  await context.orchestrator.endedById(target, created.migration.id).catch(() => {});
  expect(context.runtime).toEqual(["start:agent-1@computer-a", "start:agent-1@computer-a"]);
});

test("a reconnecting Computer fails a migration idle past its lease and runs the Agent on the source again", async () => {
  const context = setup();
  const started = await context.orchestrator.request(context.request);
  if (started.status !== "created") throw new Error(started.status);
  context.runtime.length = 0;
  const since = started.migration.updatedAt.getTime();
  // Within the grace past the lease, the Computer's own run may still be finishing.
  await context.orchestrator.recover(
    workspaceId,
    "computer-a",
    since + AGENT_MIGRATION_LEASE_MS + 1,
  );
  expect(context.rows.get(started.migration.id)!.state).toBe("requested");
  const leasesBefore = context.leases().length;
  await context.orchestrator.recover(
    workspaceId,
    "computer-a",
    since + AGENT_MIGRATION_LEASE_MS + 61_000,
  );
  expect(context.rows.get(started.migration.id)).toMatchObject({
    state: "failed",
    errorCode: "lease_expired",
  });
  expect(context.runtime).toEqual(["start:agent-1@computer-a"]);
  // The source is told to let go before the Start reaches it, and the expired one is not leased.
  expect(context.order).toEqual(["cancel:source", "cancel:target", "start"]);
  expect(context.leases()).toHaveLength(leasesBefore);
});

test("a reconnecting Computer within the lease is only leased again", async () => {
  const context = setup();
  const started = await context.orchestrator.request(context.request);
  if (started.status !== "created") throw new Error(started.status);
  await context.orchestrator.recover(
    workspaceId,
    "computer-a",
    started.migration.updatedAt.getTime(),
  );
  expect(context.rows.get(started.migration.id)!.state).toBe("requested");
  expect(context.leases()).toHaveLength(2);
});

test("a target that reconnects after a switch nobody followed up starts the Agent and completes it", async () => {
  const context = setup();
  const started = await context.orchestrator.request(context.request);
  if (started.status !== "created") throw new Error(started.status);
  await upToPlacing(context, started.migration.id);
  // The switch landed, but the server stopped before it started the Agent or sent `arrived`.
  await context.migrations.advance(target, {
    migrationId: started.migration.id,
    generation: 1,
    expectedRevision: 3,
    step: "switch",
  });
  await context.orchestrator.recover(workspaceId, "computer-b", Date.now());
  expect(context.runtime.at(-1)).toBe("start:agent-1@computer-b");
  expect(context.rows.get(started.migration.id)!.state).toBe("completed");
});

test("a source that reconnects also finishes a switch nobody followed up", async () => {
  const context = setup();
  const started = await context.orchestrator.request(context.request);
  if (started.status !== "created") throw new Error(started.status);
  await upToPlacing(context, started.migration.id);
  await context.migrations.advance(target, {
    migrationId: started.migration.id,
    generation: 1,
    expectedRevision: 3,
    step: "switch",
  });
  await context.orchestrator.recover(workspaceId, "computer-a", Date.now());
  expect(context.rows.get(started.migration.id)!.state).toBe("completed");
});

test("one migration that cannot be moved on keeps none of the others from it", async () => {
  const context = setup({ publishFails: true });
  const stuck = await context.migrations.request(context.request);
  const switching = await context.migrations.request({ ...context.request, agentId: "agent-2" });
  if (stuck.status !== "created" || switching.status !== "created") throw new Error("setup");
  for (const [revision, step] of [
    [0, "source_stopped"],
    [1, "upload_complete"],
  ] as const)
    await context.migrations.advance(source, {
      migrationId: switching.migration.id,
      generation: 1,
      expectedRevision: revision,
      step,
      ...(step === "upload_complete" ? { manifest: {} } : {}),
    });
  for (const [revision, step] of [
    [2, "placement_started"],
    [3, "switch"],
  ] as const)
    await context.migrations.advance(target, {
      migrationId: switching.migration.id,
      generation: 1,
      expectedRevision: revision,
      step,
    });
  // The lease for the first cannot be published; the second still completes.
  await expect(context.orchestrator.recover(workspaceId, "computer-a", Date.now())).rejects.toThrow(
    "unreachable",
  );
  expect(context.rows.get(switching.migration.id)!.state).toBe("completed");
});

test("a migration's objects leave the bucket once it completes, fails or is canceled", async () => {
  const context = setup();
  const done = await context.orchestrator.request(context.request);
  if (done.status !== "created") throw new Error(done.status);
  await upToPlacing(context, done.migration.id);
  const switched = await context.migrations.advance(target, {
    migrationId: done.migration.id,
    generation: 1,
    expectedRevision: 3,
    step: "switch",
  });
  if (switched.status !== "advanced") throw new Error(switched.status);
  await context.orchestrator.switched(switched.migration);
  // The fixture's placement moved with the first Agent, so the second goes back the other way.
  const canceled = await context.orchestrator.request({
    ...context.request,
    agentId: "agent-2",
    targetComputerId: "computer-a",
  });
  if (canceled.status !== "created") throw new Error(canceled.status);
  await context.orchestrator.cancel({ workspaceId, migrationId: canceled.migration.id });
  expect(context.removed).toEqual([
    `workspaces/${workspaceId}/agents/agent-1/migrations/${done.migration.id}/`,
    `workspaces/${workspaceId}/agents/agent-2/migrations/${canceled.migration.id}/`,
  ]);
});

test("a migration that fails leaves its objects in the bucket no longer", async () => {
  const context = setup();
  const started = await context.orchestrator.request(context.request);
  if (started.status !== "created") throw new Error(started.status);
  const failed = await context.migrations.fail(target, {
    migrationId: started.migration.id,
    generation: 1,
    errorCode: "download_failed",
  });
  if (failed.status !== "failed") throw new Error(failed.status);
  await context.orchestrator.ended(failed.migration);
  expect(context.removed).toEqual([
    `workspaces/${workspaceId}/agents/agent-1/migrations/${started.migration.id}/`,
  ]);
});

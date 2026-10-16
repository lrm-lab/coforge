import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentMigrations,
  FINISHED_AGENT_MIGRATION_STATES,
  type AgentMigrationStep,
  type MigrationParticipant,
} from "#src/server/agent-migrations/agent-migrations.server";
import { memoryStore } from "./helpers/agent-migration-memory-store";

const workspaceId = "workspace-1";
const source = { workspaceId, computerId: "computer-a" };
const target = { workspaceId, computerId: "computer-b" };
const REQUEST = {
  workspaceId,
  agentId: "agent-1",
  targetComputerId: "computer-b",
  requestedByUserId: "user-1",
};

async function requested(fixture = memoryStore()) {
  const migrations = new AgentMigrations(fixture.store);
  const result = await migrations.request(REQUEST);
  if (result.status !== "created") throw new Error(`expected created, got ${result.status}`);
  return { migrations, migration: result.migration, ...fixture };
}

/** Takes a step at the migration's current generation and revision, as a Daemon would. */
async function step(
  migrations: AgentMigrations,
  migrationId: string,
  participant: MigrationParticipant,
  name: AgentMigrationStep,
) {
  const current = (await migrations.view(participant, migrationId))!;
  return migrations.advance(participant, {
    migrationId,
    generation: current.generation,
    expectedRevision: current.revision,
    step: name,
    ...(name === "upload_complete" ? { manifest: MANIFEST } : {}),
  });
}

/** What a source sends with `upload_complete`; the domain keeps it without reading it. */
const MANIFEST = { format: "tar+gzip", sha256: "abc", chunks: [] };

test("the one-active index finishes on the same states as the domain", () => {
  const schema = readFileSync(join(import.meta.dir, "../prisma/schema.prisma"), "utf8");
  // Spelled as AND-ed `<>` rather than `NOT IN`: PostgreSQL stores `NOT IN` as `<> ALL (ARRAY…)`,
  // which Prisma's diff never matches back to the schema, so every `migrate dev` would re-create it.
  const predicate = FINISHED_AGENT_MIGRATION_STATES.map(
    (state) => `\\"state\\" <> '${state}'`,
  ).join(" AND ");
  expect(schema).toContain(`where: raw("${predicate}")`);
});

test("a request records the Agent's current Computer as the source", async () => {
  const { migration } = await requested();
  expect(migration).toMatchObject({
    agentId: "agent-1",
    sourceComputerId: "computer-a",
    targetComputerId: "computer-b",
    state: "requested",
  });
});

test("a request is refused when the target is the Agent's own Computer or outside the Workspace", async () => {
  const migrations = new AgentMigrations(memoryStore().store);
  expect(await migrations.request({ ...REQUEST, targetComputerId: "computer-a" })).toEqual({
    status: "refused",
    code: "same_computer",
  });
  expect(await migrations.request({ ...REQUEST, targetComputerId: "computer-z" })).toEqual({
    status: "refused",
    code: "target_unavailable",
  });
});

test("a request is refused for a missing Agent or one with no Computer to move from", async () => {
  expect(await new AgentMigrations(memoryStore(null).store).request(REQUEST)).toEqual({
    status: "refused",
    code: "agent_not_found",
  });
  expect(
    await new AgentMigrations(memoryStore({ computerId: null }).store).request(REQUEST),
  ).toEqual({ status: "refused", code: "agent_unplaced" });
});

test("a second request while one is active is refused", async () => {
  const { migrations } = await requested();
  expect(await migrations.request(REQUEST)).toEqual({
    status: "refused",
    code: "already_migrating",
  });
});

test("the happy path moves the Agent to the target at the switch and completes on arrival", async () => {
  const { migrations, migration, agentComputer } = await requested();
  const id = migration.id;
  expect(await step(migrations, id, source, "source_stopped")).toMatchObject({
    status: "advanced",
    migration: { state: "source_stopped" },
  });
  expect(await step(migrations, id, source, "upload_complete")).toMatchObject({
    migration: { state: "uploaded" },
  });
  expect(await step(migrations, id, target, "placement_started")).toMatchObject({
    migration: { state: "placing" },
  });
  expect(agentComputer.value).toBe("computer-a");
  expect(await step(migrations, id, target, "switch")).toMatchObject({
    migration: { state: "switched" },
  });
  expect(agentComputer.value).toBe("computer-b");
  expect(await step(migrations, id, target, "arrived")).toMatchObject({
    migration: { state: "completed" },
  });
});

test("the switch is refused when the Agent already left the source Computer", async () => {
  const { migrations, migration, agentComputer, rows } = await requested();
  const id = migration.id;
  await step(migrations, id, source, "source_stopped");
  await step(migrations, id, source, "upload_complete");
  await step(migrations, id, target, "placement_started");
  agentComputer.value = "computer-c";
  expect(await step(migrations, id, target, "switch")).toEqual({
    status: "refused",
    code: "agent_moved",
  });
  // The Agent is elsewhere: the migration ends instead of holding the Agent's one active slot.
  expect(rows.get(id)).toMatchObject({ state: "failed", errorCode: "agent_moved" });
  expect(agentComputer.value).toBe("computer-c");
});

test("the switch is refused when the target Computer is gone", async () => {
  const fixture = memoryStore();
  const { migrations, migration, rows, agentComputer } = await requested(fixture);
  const id = migration.id;
  await step(migrations, id, source, "source_stopped");
  await step(migrations, id, source, "upload_complete");
  await step(migrations, id, target, "placement_started");
  fixture.liveComputers.delete("computer-b");
  expect(await step(migrations, id, target, "switch")).toEqual({
    status: "refused",
    code: "target_unavailable",
  });
  expect(rows.get(id)).toMatchObject({ state: "failed", errorCode: "target_unavailable" });
  expect(agentComputer.value).toBe("computer-a");
});

test("a step from the wrong Computer is refused without changing the migration", async () => {
  const { migrations, migration, rows } = await requested();
  const result = await migrations.advance(target, {
    migrationId: migration.id,
    generation: 1,
    expectedRevision: 0,
    step: "source_stopped",
  });
  expect(result).toEqual({ status: "refused", code: "wrong_computer" });
  expect(rows.get(migration.id)!.state).toBe("requested");
});

test("a Computer outside the migration's Workspace cannot read or drive it", async () => {
  const { migrations, migration } = await requested();
  const stranger = { workspaceId: "workspace-2", computerId: "computer-a" };
  expect(await migrations.view(stranger, migration.id)).toBeNull();
  expect(
    await migrations.advance(stranger, {
      migrationId: migration.id,
      generation: 1,
      expectedRevision: 0,
      step: "source_stopped",
    }),
  ).toEqual({ status: "refused", code: "not_found" });
});

test("repeating an applied step reports it as already applied", async () => {
  const { migrations, migration } = await requested();
  const stop = {
    migrationId: migration.id,
    generation: 1,
    expectedRevision: 0,
    step: "source_stopped" as const,
  };
  await migrations.advance(source, stop);
  expect(await migrations.advance(source, stop)).toMatchObject({
    status: "already_applied",
    migration: { state: "source_stopped" },
  });
});

test("a step out of order is refused", async () => {
  const { migrations, migration } = await requested();
  expect(await step(migrations, migration.id, target, "switch")).toEqual({
    status: "refused",
    code: "invalid_transition",
  });
});

test("a step from an older transfer attempt or at a stale revision is refused", async () => {
  const { migrations, migration } = await requested();
  const stop = { migrationId: migration.id, step: "source_stopped" as const };
  expect(await migrations.advance(source, { ...stop, generation: 0, expectedRevision: 0 })).toEqual(
    { status: "refused", code: "stale_generation" },
  );
  expect(await migrations.advance(source, { ...stop, generation: 1, expectedRevision: 7 })).toEqual(
    { status: "refused", code: "stale_revision" },
  );
});

test("cancel before the switch ends the migration and leaves the Agent on the source", async () => {
  const { migrations, migration, agentComputer } = await requested();
  expect(await migrations.cancel({ workspaceId, migrationId: migration.id })).toMatchObject({
    status: "canceled",
    migration: { state: "canceled" },
  });
  expect(agentComputer.value).toBe("computer-a");
  expect(
    await migrations.advance(source, {
      migrationId: migration.id,
      generation: 1,
      expectedRevision: 1,
      step: "source_stopped",
    }),
  ).toEqual({ status: "refused", code: "finished" });
});

async function switched() {
  const fixture = await requested();
  const id = fixture.migration.id;
  await step(fixture.migrations, id, source, "source_stopped");
  await step(fixture.migrations, id, source, "upload_complete");
  await step(fixture.migrations, id, target, "placement_started");
  await step(fixture.migrations, id, target, "switch");
  return fixture;
}

test("cancel after the switch ends the migration with the Agent kept on the target", async () => {
  const { migrations, migration, agentComputer } = await switched();
  const result = await migrations.cancel({ workspaceId, migrationId: migration.id });
  expect(result).toMatchObject({ status: "canceled", migration: { state: "canceled" } });
  if (result.status !== "canceled") throw new Error("unreachable");
  // A post-switch cancel only cleans up: the target already owns the Agent and keeps it.
  expect(result.migration.switchedAt).not.toBeNull();
  expect(agentComputer.value).toBe("computer-b");
});

test("a failure report after the switch is refused: the target owns the Agent", async () => {
  const { migrations, migration, rows } = await switched();
  expect(
    await migrations.fail(target, {
      migrationId: migration.id,
      generation: 1,
      errorCode: "start_failed",
    }),
  ).toEqual({ status: "refused", code: "past_switch" });
  expect(rows.get(migration.id)!.state).toBe("switched");
});

test("a participant's failure report ends the migration with its error code", async () => {
  const { migrations, migration } = await requested();
  expect(
    await migrations.fail(target, {
      migrationId: migration.id,
      generation: 1,
      errorCode: "chunk_digest_mismatch",
      errorDetail: "chunk 3",
    }),
  ).toMatchObject({
    status: "failed",
    migration: { state: "failed", errorCode: "chunk_digest_mismatch" },
  });
});

test("upload completion carries the bundle manifest, stored with the step", async () => {
  const { migrations, migration, manifests } = await requested();
  await step(migrations, migration.id, source, "source_stopped");
  const current = (await migrations.view(source, migration.id))!;
  const bare = {
    migrationId: migration.id,
    generation: 1,
    expectedRevision: current.revision,
    step: "upload_complete" as const,
  };
  expect(await migrations.advance(source, bare)).toEqual({
    status: "refused",
    code: "manifest_required",
  });
  expect(await migrations.advance(source, { ...bare, manifest: MANIFEST })).toMatchObject({
    status: "advanced",
    migration: { state: "uploaded" },
  });
  expect(manifests.get(migration.id)).toEqual(MANIFEST);
  expect(await migrations.manifest((await migrations.view(target, migration.id))!)).toEqual(
    MANIFEST,
  );
});

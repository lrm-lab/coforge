import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { taskConversationsGate } from "#src/server/tasks/task-conversations-gate.server";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
let directory = "";
let workspaceId = "";
let slug = "";
let ownerId = "";
let agentId = "";

const flagFile = (on: boolean) =>
  JSON.stringify({
    $schema: "https://flagd.dev/schema/v0/flags.json",
    flags: {
      "task-conversations": {
        state: "ENABLED",
        variants: { on: true, off: false },
        defaultVariant: on ? "on" : "off",
      },
    },
  });

beforeAll(async () => {
  const owner = await db.user.create({
    data: { username: `gate-owner-${suffix}`, displayName: "Owner" },
  });
  ownerId = owner.id;
  slug = `task-conv-gate-${suffix}`;
  const workspace = await db.workspace.create({
    data: {
      slug,
      name: "Gate",
      members: { create: { userId: owner.id, role: "member" } },
      agents: {
        create: { name: `gate-agent-${suffix}`, displayName: "A", ownerId, runtimeConfig: {} },
      },
    },
    include: { agents: true },
  });
  workspaceId = workspace.id;
  agentId = workspace.agents[0]!.id;
  directory = await mkdtemp(join(tmpdir(), "coforge-task-conv-gate-"));
});

afterAll(async () => {
  await installFeatureFlags({ status: "disabled" });
  await rm(directory, { recursive: true, force: true });
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.$disconnect();
});

async function install(on: boolean) {
  const path = join(directory, `flags-${on}.json`);
  await writeFile(path, flagFile(on));
  await installFeatureFlags(
    await readFeatureFlagsConfiguration({ COFORGE_FEATURE_FLAGS_FILE: path }),
  );
}

test("the Workspace's switch decides, and only where the Workspace flag is on", async () => {
  const gate = taskConversationsGate(db, { workspaceId, agentId });
  const experiments = new PrismaExperimentsRepository(db);

  await install(false);
  await experiments.write(workspaceId, "taskConversations", true);
  expect(await gate()).toBe(false); // switched on, but the Workspace flag is off

  await install(true);
  expect(await gate()).toBe(true);
  await experiments.write(workspaceId, "taskConversations", false);
  expect(await gate()).toBe(false); // the flag is on, nobody has switched it on

  expect(await taskConversationsGate(db, { workspaceId: crypto.randomUUID(), agentId })()).toBe(
    false,
  );
});

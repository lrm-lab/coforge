import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { Experiments } from "#src/server/experiments/experiments.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import {
  installFeatureFlags,
  isFeatureEnabled,
} from "#src/server/feature-flags/feature-flags.server";
import {
  requireComputersForTaskConversations,
  taskComputerRefusal,
} from "#src/server/tasks/task-computer-gate.server";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
let directory = "";
let ownerId = "";
let workspaceId = "";
let slug = "";
const computers: Record<string, string> = {};
const agents: Record<string, string> = {};

beforeAll(async () => {
  const owner = await db.user.create({
    data: { username: `tcg-owner-${suffix}`, displayName: "Owner" },
  });
  ownerId = owner.id;
  slug = `task-computer-gate-${suffix}`;
  const workspace = await db.workspace.create({
    data: { slug, name: "Gate", members: { create: { userId: owner.id, role: "owner" } } },
  });
  workspaceId = workspace.id;
  for (const [key, version] of [
    ["old", "0.1.18"],
    ["new", "0.1.19-dev.3"],
  ] as const) {
    const computer = await db.computer.create({
      data: {
        ownerId,
        machineId: crypto.randomUUID(),
        name: `${key}-${suffix}`,
        displayName: `Studio ${key}`,
        computerVersion: version,
      },
    });
    computers[key] = computer.id;
    const agent = await db.agent.create({
      data: {
        workspaceId,
        ownerId,
        name: `tcg-${key}-${suffix}`,
        displayName: key,
        computerId: computer.id,
        runtimeConfig: {},
      },
    });
    agents[key] = agent.id;
  }
  directory = await mkdtemp(join(tmpdir(), "coforge-task-computer-gate-"));
  const path = join(directory, "flags.json");
  await writeFile(
    path,
    JSON.stringify({
      $schema: "https://flagd.dev/schema/v0/flags.json",
      flags: {
        "task-conversations": {
          state: "ENABLED",
          variants: { on: true, off: false },
          defaultVariant: "on",
        },
      },
    }),
  );
  await installFeatureFlags(
    await readFeatureFlagsConfiguration({ COFORGE_FEATURE_FLAGS_FILE: path }),
  );
});

afterAll(async () => {
  await installFeatureFlags({ status: "disabled" });
  await rm(directory, { recursive: true, force: true });
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.computer.deleteMany({ where: { id: { in: Object.values(computers) } } });
  await db.user.delete({ where: { id: ownerId } });
  await db.$disconnect();
});

const experiments = () =>
  new Experiments(new PrismaExperimentsRepository(db), isFeatureEnabled, {
    taskConversations: (id) => requireComputersForTaskConversations(db, id),
  });
const workspace = () => ({ workspaceId, workspaceSlug: slug });

test("the switch refuses to open while a Computer with an Agent is older than 0.1.19, naming it", async () => {
  const refused = await experiments()
    .set(workspace(), "owner", "taskConversations", true)
    .catch((error: unknown) => error);
  expect(isAppError(refused)).toBe(true);
  expect(refused).toMatchObject({
    code: "CONFLICT",
    errorId: "computers-need-upgrade",
    details: { version: "0.1.19", computers: "Studio old" },
  });
  expect(await experiments().enabled("taskConversations", workspace())).toBe(false);
  // Closing it is never refused.
  await experiments().set(workspace(), "owner", "taskConversations", false);
});

test("a Computer with an unknown version counts as older", async () => {
  await db.computer.update({ where: { id: computers.old }, data: { computerVersion: null } });
  await expect(requireComputersForTaskConversations(db, workspaceId)).rejects.toMatchObject({
    errorId: "computers-need-upgrade",
  });
});

test("an Agent on an older Computer is refused every Task request while the switch is on", async () => {
  await new PrismaExperimentsRepository(db).write(workspaceId, "taskConversations", true);
  const refusal = await taskComputerRefusal(db, { workspaceId, agentId: agents.old });
  expect(refusal?.status).toBe(426);
  expect(await refusal?.json()).toMatchObject({
    code: "CLIENT_UPGRADE_REQUIRED",
    retryable: false,
    error: expect.stringContaining("0.1.19"),
  });
  expect(await taskComputerRefusal(db, { workspaceId, agentId: agents.new })).toBeUndefined();
});

test("with the switch off an older Computer's Agent works as before", async () => {
  await new PrismaExperimentsRepository(db).write(workspaceId, "taskConversations", false);
  expect(await taskComputerRefusal(db, { workspaceId, agentId: agents.old })).toBeUndefined();
});

test("once every Computer is current the switch opens", async () => {
  await db.computer.update({ where: { id: computers.old }, data: { computerVersion: "0.1.19" } });
  const view = await experiments().set(workspace(), "owner", "taskConversations", true);
  expect(view.enabled).toBe(true);
});

import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import type { ComputerRegisterRequest } from "@lrm/coforge-sdk/internal";
import { PrismaComputerRegistrationRepository } from "#src/server/db/repositories/setup.repositories.server";
import { hashDaemonApiKey } from "#src/server/auth/daemon-api-key.server";

/** Re-running setup/attach on a machine the server already knows must land on the same
 * Computer row, never a second one (task #417): the CLI resumes a live local attachment
 * without registering, and this upsert is the net for a registration retried after local
 * state was lost. */
const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
let ownerId = "";
let workspaceId = "";

const request = (overrides: Partial<ComputerRegisterRequest> = {}): ComputerRegisterRequest => ({
  protocolMajor: 1,
  requestId: crypto.randomUUID(),
  workspaceSlug: "",
  name: `reg-${suffix}`,
  displayName: `reg-${suffix}`,
  machineId: `machine-${suffix}`,
  platform: "linux",
  osVersion: "1",
  computerVersion: "1",
  registrationIdempotencyKey: crypto.randomUUID(),
  ...overrides,
});

afterAll(async () => {
  if (ownerId) await db.computer.deleteMany({ where: { ownerId } });
  if (workspaceId) await db.workspace.deleteMany({ where: { id: workspaceId } });
  if (ownerId) await db.user.deleteMany({ where: { id: ownerId } });
  await db.$disconnect();
});

test("a repeated registration reuses the Computer row and rotates its key", async () => {
  const owner = await db.user.create({
    data: { username: `reg-${suffix}`, displayName: "Reg" },
  });
  ownerId = owner.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `reg-${suffix}`,
      name: "Reg",
      members: { create: { userId: owner.id, role: "owner" } },
    },
  });
  workspaceId = workspace.id;
  const repository = new PrismaComputerRegistrationRepository(db);
  const principal = { userId: owner.id };
  const target = { id: workspace.id, slug: workspace.slug };

  const first = await repository.register({
    principal,
    workspace: target,
    request: request(),
  });
  const second = await repository.register({
    principal,
    workspace: target,
    request: request(),
  });

  expect(second.computerId).toBe(first.computerId);
  expect(
    await db.computer.count({ where: { ownerId: owner.id, machineId: `machine-${suffix}` } }),
  ).toBe(1);
  expect(
    await db.workspaceComputer.count({
      where: { workspaceId: workspace.id, computerId: first.computerId },
    }),
  ).toBe(1);
  expect(second.daemonApiKey).not.toBe(first.daemonApiKey);
  expect(
    (
      await db.daemonApiKey.findFirstOrThrow({
        where: { apiKeyHash: hashDaemonApiKey(first.daemonApiKey) },
      })
    ).revokedAt,
  ).not.toBeNull();
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { resolveComputerOfflineAlertTarget } from "#src/server/computers/computer-offline-alerts.server";

/**
 * Where a Computer offline alert lands: the earliest WorkspaceComputer binding whose Workspace
 * still has the Computer's owner as a member — one notice per owner per outage, never one per
 * link (task #17).
 */
const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);

let ownerId: string;
let workspaceA: string;
let workspaceB: string;
let workspaceC: string;
let computerId: string;

beforeAll(async () => {
  const owner = await db.user.create({
    data: { username: `coa-${handle}`, displayName: "Owner" },
  });
  ownerId = owner.id;
  const member = await db.user.create({
    data: { username: `com-${handle}`, displayName: "Member" },
  });
  workspaceA = (
    await db.workspace.create({
      data: {
        slug: `coa-a-${handle}`,
        name: "A",
        members: {
          create: [
            { userId: ownerId, role: "owner" },
            { userId: member.id, role: "member" },
          ],
        },
      },
    })
  ).id;
  workspaceB = (
    await db.workspace.create({
      data: {
        slug: `coa-b-${handle}`,
        name: "B",
        members: { create: [{ userId: ownerId, role: "member" }] },
      },
    })
  ).id;
  workspaceC = (
    await db.workspace.create({
      data: { slug: `coa-c-${handle}`, name: "C", members: { create: [] } },
    })
  ).id;
  computerId = (
    await db.computer.create({
      data: {
        ownerId,
        machineId: `coa-machine-${handle}`,
        name: "studio",
        displayName: "Frank's Mac Studio",
      },
    })
  ).id;
});

afterAll(async () => {
  await db.workspaceComputer.deleteMany({ where: { computerId } });
  await db.computer.deleteMany({ where: { id: computerId } });
  await db.workspace.deleteMany({ where: { id: { in: [workspaceA, workspaceB, workspaceC] } } });
  await db.user.deleteMany({ where: { username: { startsWith: `coa-` } } });
  await db.$disconnect();
});

test("the earliest binding whose Workspace still has the owner wins", async () => {
  await db.workspaceComputer.createMany({
    data: [
      { workspaceId: workspaceB, computerId },
      { workspaceId: workspaceA, computerId },
    ],
  });
  // Backdate B's binding so A is unambiguously earlier.
  await db.workspaceComputer.update({
    where: { workspaceId_computerId: { workspaceId: workspaceB, computerId } },
    data: { createdAt: new Date(Date.now() + 60_000) },
  });
  const target = await resolveComputerOfflineAlertTarget(db, computerId);
  expect(target).toMatchObject({
    status: "ready",
    workspaceId: workspaceA,
    ownerId,
    computerName: "Frank's Mac Studio",
    workspaceSlug: `coa-a-${handle}`,
  });
});

test("a binding whose Workspace lost the owner is skipped for a later one", async () => {
  await db.workspaceMembership.delete({
    where: { workspaceId_userId: { workspaceId: workspaceA, userId: ownerId } },
  });
  const target = await resolveComputerOfflineAlertTarget(db, computerId);
  expect(target).toMatchObject({ status: "ready", workspaceId: workspaceB });
  await db.workspaceMembership.create({
    data: { workspaceId: workspaceA, userId: ownerId, role: "owner" },
  });
});

test("no eligible Workspace consumes the episode silently", async () => {
  await db.workspaceMembership.deleteMany({
    where: { userId: ownerId, workspaceId: { in: [workspaceA, workspaceB] } },
  });
  const target = await resolveComputerOfflineAlertTarget(db, computerId);
  expect(target.status).toBe("no_workspace");
  await db.workspaceMembership.createMany({
    data: [
      { workspaceId: workspaceA, userId: ownerId, role: "owner" },
      { workspaceId: workspaceB, userId: ownerId, role: "member" },
    ],
  });
});

test("a Computer with no bindings has no Workspace to take the notice", async () => {
  const unbound = await db.computer.create({
    data: { ownerId, machineId: `coa-unbound-${handle}`, name: "unbound" },
  });
  try {
    const target = await resolveComputerOfflineAlertTarget(db, unbound.id);
    expect(target.status).toBe("no_workspace");
  } finally {
    await db.computer.delete({ where: { id: unbound.id } });
  }
});

test("a deleted Computer is gone", async () => {
  await db.computer.update({ where: { id: computerId }, data: { deletedAt: new Date() } });
  const target = await resolveComputerOfflineAlertTarget(db, computerId);
  expect(target.status).toBe("gone");
  await db.computer.update({ where: { id: computerId }, data: { deletedAt: null } });
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { agentReadinessPermissions } from "#src/server/agents/agent-readiness-permissions.server";

function database() {
  const connectionString = Bun.env.PREFERENCES_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("PREFERENCES_TEST_DATABASE_URL must point to local PostgreSQL");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

const LOGIN = { state: "runtime_login_required" };
const LOGIN_VIA_LAUNCH = { state: "launch_failed", detail: "runtime_login_required" };
const OTHER_LAUNCH = { state: "launch_failed", detail: "model_not_found" };
const OFFLINE = { state: "computer_offline" };

let db: PrismaClient;
let workspaceId: string;
let owner: { id: string };
let admin: { id: string };
let member: { id: string };
let sharedComputerId: string;
let privateComputerId: string;
let cloudComputerId: string;

beforeAll(async () => {
  db = database();
  const fixture = crypto.randomUUID();
  const [ownerRow, adminRow, memberRow] = await Promise.all([
    db.user.create({
      data: { displayName: `perm-o-${fixture}`, username: `perm-o-${fixture}` },
    }),
    db.user.create({
      data: { displayName: `perm-a-${fixture}`, username: `perm-a-${fixture}` },
    }),
    db.user.create({
      data: { displayName: `perm-m-${fixture}`, username: `perm-m-${fixture}` },
    }),
  ]);
  owner = ownerRow;
  admin = adminRow;
  member = memberRow;
  const workspace = await db.workspace.create({
    data: {
      slug: `perm-${fixture}`,
      name: "Readiness permissions",
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: admin.id, role: "admin" },
          { userId: member.id, role: "member" },
        ],
      },
    },
  });
  workspaceId = workspace.id;
  const [shared, privateRt, cloud] = await Promise.all([
    db.computer.create({
      data: { ownerId: owner.id, machineId: `perm-${fixture}-shared`, name: "Shared" },
    }),
    db.computer.create({
      data: { ownerId: owner.id, machineId: `perm-${fixture}-private`, name: "Private" },
    }),
    db.computer.create({
      data: {
        ownerId: owner.id,
        machineId: `perm-${fixture}-cloud`,
        name: "Cloud",
        kind: "cloud",
        cloudSlot: "default",
      },
    }),
  ]);
  sharedComputerId = shared.id;
  privateComputerId = privateRt.id;
  cloudComputerId = cloud.id;
  await db.workspaceComputer.createMany({
    data: [shared, privateRt, cloud].map((computer) => ({
      workspaceId,
      computerId: computer.id,
    })),
  });
  await db.computerRuntime.createMany({
    data: [
      {
        workspaceId,
        computerId: shared.id,
        provider: "pi",
        version: "1.0.0",
        displayName: "Pi",
        isPublic: true,
      },
      {
        workspaceId,
        computerId: privateRt.id,
        provider: "pi",
        version: "1.0.0",
        displayName: "Pi",
        isPublic: false,
      },
      {
        workspaceId,
        computerId: cloud.id,
        provider: "pi",
        version: "1.0.0",
        displayName: "Pi",
        isPublic: true,
      },
    ],
  });
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.computer.deleteMany({ where: { ownerId: owner.id } });
  await db.user.deleteMany({ where: { id: { in: [owner.id, admin.id, member.id] } } });
  await db.$disconnect();
});

function authReads(db: PrismaClient) {
  let reads = 0;
  const spy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "workspaceComputer" || prop === "computerRuntime") reads += 1;
      return Reflect.get(target, prop, receiver);
    },
  });
  return { db: spy, reads: () => reads };
}

function permissions(
  viewer: { id: string; role: string },
  computerId: string | undefined,
  readiness: { state: string; detail?: string | null },
  client: PrismaClient = db,
) {
  return agentReadinessPermissions(client, {
    userId: viewer.id,
    workspaceId,
    memberRole: viewer.role,
    computerId,
    provider: "pi",
    readiness,
  });
}

test("a workspace admin manages login on another member's shared runtime", async () => {
  for (const readiness of [LOGIN, LOGIN_VIA_LAUNCH]) {
    const result = await permissions({ id: admin.id, role: "admin" }, sharedComputerId, readiness);
    expect(result.canManageRuntimeLogin).toBe(true);
    expect(result.canControlAgentRuntime).toBe(true);
  }
});

test("a private runtime and another member's default cloud Computer refuse login management", async () => {
  const privateResult = await permissions(
    { id: admin.id, role: "admin" },
    privateComputerId,
    LOGIN,
  );
  expect(privateResult.canManageRuntimeLogin).toBe(false);
  const cloudResult = await permissions({ id: admin.id, role: "admin" }, cloudComputerId, LOGIN);
  expect(cloudResult.canManageRuntimeLogin).toBe(false);
});

test("an ordinary member starts the Agent but cannot manage runtime login", async () => {
  const result = await permissions({ id: member.id, role: "member" }, sharedComputerId, LOGIN);
  expect(result.canManageRuntimeLogin).toBe(false);
  expect(result.canControlAgentRuntime).toBe(true);
});

test("the Computer owner manages login on their own Computer", async () => {
  const result = await permissions({ id: owner.id, role: "owner" }, sharedComputerId, LOGIN);
  expect(result.canManageRuntimeLogin).toBe(true);
});

test("readiness states that cannot show the login line never consult runtime authorization", async () => {
  for (const readiness of [OFFLINE, OTHER_LAUNCH, { state: "ready" }]) {
    const spy = authReads(db);
    const result = await permissions(
      { id: admin.id, role: "admin" },
      sharedComputerId,
      readiness,
      spy.db,
    );
    expect(result.canManageRuntimeLogin).toBe(false);
    expect(spy.reads()).toBe(0);
  }
});

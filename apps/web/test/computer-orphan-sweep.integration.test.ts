import { afterEach, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { hashDaemonApiKey, prepareDaemonApiKey } from "#src/server/auth/daemon-api-key.server";
import { sweepOrphanComputerLinks } from "#src/server/computers/computer-orphan-sweep.server";

/**
 * The hourly orphan sweep (task #417): a `computer:register` whose Daemon never started leaves a
 * `workspace_computers` link, a Computer and a live key that nothing will ever use. A link older
 * than an hour whose Computer never reported `computerVersion` is removed with its keys; the
 * Computer row goes only once no Workspace link and no dependent row remains.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

let db: PrismaClient | undefined;
const database = () =>
  (db ??= new PrismaClient({
    adapter: new PrismaPg({ connectionString: connectionString! }),
  }));

const HOUR = 60 * 60_000;

// The sweep counts every orphan in the shared scratch database, so each fixture is removed
// after its test — including the rows a dry run or a kept Computer leaves behind.
const fixtures: Array<{ ownerId: string; workspaceIds: string[]; computerIds: string[] }> = [];
afterEach(async () => {
  if (!db) return;
  for (const f of fixtures.splice(0)) {
    await db.workspaceComputer.deleteMany({
      where: { workspaceId: { in: f.workspaceIds } },
    });
    await db.computerRuntime.deleteMany({
      where: { computerId: { in: f.computerIds } },
    });
    await db.daemonApiKey.deleteMany({ where: { computerId: { in: f.computerIds } } });
    await db.computer.deleteMany({ where: { id: { in: f.computerIds } } });
    await db.workspace.deleteMany({ where: { id: { in: f.workspaceIds } } });
    await db.user.deleteMany({ where: { id: f.ownerId } });
  }
});

async function fixture(options: {
  computerVersion?: string | null;
  kind?: string;
  linkAgeMs?: number;
  extraWorkspace?: boolean;
  withRuntime?: boolean;
}) {
  const client = database();
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await client.user.create({
    data: { username: `orphan-${suffix}`, displayName: "Orphan" },
  });
  const workspace = await client.workspace.create({
    data: {
      slug: `orphan-${suffix}`,
      name: "Orphan",
      members: { create: { userId: owner.id, role: "member" } },
    },
  });
  const computer = await client.computer.create({
    data: {
      ownerId: owner.id,
      machineId: `machine-${suffix}`,
      name: `orphan-${suffix}`,
      kind: options.kind ?? "local",
      computerVersion: options.computerVersion ?? null,
    },
  });
  const createdAt = new Date(Date.now() - (options.linkAgeMs ?? 2 * HOUR));
  await client.workspaceComputer.create({
    data: {
      workspaceId: workspace.id,
      computerId: computer.id,
      createdAt,
    },
  });
  const workspaceIds = [workspace.id];
  if (options.extraWorkspace) {
    const other = await client.workspace.create({
      data: {
        slug: `orphan2-${suffix}`,
        name: "Other",
        members: { create: { userId: owner.id, role: "member" } },
      },
    });
    workspaceIds.push(other.id);
    await client.workspaceComputer.create({
      data: { workspaceId: other.id, computerId: computer.id },
    });
  }
  if (options.withRuntime) {
    await client.computerRuntime.create({
      data: {
        workspaceId: workspace.id,
        computerId: computer.id,
        provider: "codex",
        version: "1.0.0",
        displayName: "Codex",
      },
    });
  }
  const { apiKey, record } = prepareDaemonApiKey({
    principal: { userId: owner.id },
    workspaceId: workspace.id,
    computerId: computer.id,
  });
  const key = await client.daemonApiKey.create({ data: record });
  fixtures.push({ ownerId: owner.id, workspaceIds, computerIds: [computer.id] });
  return { owner, workspace, computer, apiKey, key };
}

const link = (workspaceId: string, computerId: string) =>
  database().workspaceComputer.findUnique({
    where: { workspaceId_computerId: { workspaceId, computerId } },
  });

test.skipIf(!connectionString)(
  "an hour-old link whose Computer never connected is unlinked, revoked and deleted",
  async () => {
    const f = await fixture({});
    const result = await sweepOrphanComputerLinks(database());
    expect(result).toMatchObject({ candidates: 1, unlinked: 1, computersDeleted: 1 });
    expect(await link(f.workspace.id, f.computer.id)).toBeNull();
    expect(await database().computer.findUnique({ where: { id: f.computer.id } })).toBeNull();
    // The Computer delete cascades its key rows; the revocation record is what a late holder reads.
    expect(await database().daemonApiKey.findUnique({ where: { id: f.key.id } })).toBeNull();
    const revocation = await database().daemonCredentialRevocation.findUnique({
      where: { apiKeyHash: hashDaemonApiKey(f.apiKey) },
    });
    expect(revocation?.reason).toBe("computer_unlinked");
  },
);

test.skipIf(!connectionString)("a link younger than an hour is left alone", async () => {
  const f = await fixture({ linkAgeMs: 30 * 60_000 });
  const result = await sweepOrphanComputerLinks(database());
  expect(result.candidates).toBe(0);
  expect(await link(f.workspace.id, f.computer.id)).not.toBeNull();
  expect(await database().computer.findUnique({ where: { id: f.computer.id } })).not.toBeNull();
});

test.skipIf(!connectionString)(
  "a Computer that reported its version is never an orphan",
  async () => {
    const f = await fixture({ computerVersion: "0.1.26" });
    const result = await sweepOrphanComputerLinks(database());
    expect(result.candidates).toBe(0);
    expect(await link(f.workspace.id, f.computer.id)).not.toBeNull();
  },
);

test.skipIf(!connectionString)("a cloud Computer is never an orphan", async () => {
  const f = await fixture({ kind: "cloud" });
  const result = await sweepOrphanComputerLinks(database());
  expect(result.candidates).toBe(0);
  expect(await link(f.workspace.id, f.computer.id)).not.toBeNull();
});

test.skipIf(!connectionString)(
  "a Computer linked to another Workspace keeps its row and that link",
  async () => {
    const f = await fixture({ extraWorkspace: true });
    const result = await sweepOrphanComputerLinks(database());
    expect(result).toMatchObject({ candidates: 1, unlinked: 1, computersDeleted: 0 });
    expect(await link(f.workspace.id, f.computer.id)).toBeNull();
    expect(await database().computer.findUnique({ where: { id: f.computer.id } })).not.toBeNull();
    expect(await database().workspaceComputer.count({ where: { computerId: f.computer.id } })).toBe(
      1,
    );
  },
);

test.skipIf(!connectionString)(
  "a Computer with dependent rows keeps its row after the link goes",
  async () => {
    const f = await fixture({ withRuntime: true });
    const result = await sweepOrphanComputerLinks(database());
    expect(result).toMatchObject({ candidates: 1, unlinked: 1, computersDeleted: 0 });
    expect(await link(f.workspace.id, f.computer.id)).toBeNull();
    expect(await database().computer.findUnique({ where: { id: f.computer.id } })).not.toBeNull();
  },
);

test.skipIf(!connectionString)("dry-run counts the candidates and writes nothing", async () => {
  const f = await fixture({});
  const result = await sweepOrphanComputerLinks(database(), new Date(), { dryRun: true });
  expect(result).toMatchObject({ candidates: 1, unlinked: 0, computersDeleted: 0 });
  expect(await link(f.workspace.id, f.computer.id)).not.toBeNull();
  expect(
    (await database().daemonApiKey.findUniqueOrThrow({ where: { id: f.key.id } })).revokedAt,
  ).toBeNull();
  expect(await database().computer.findUnique({ where: { id: f.computer.id } })).not.toBeNull();
});

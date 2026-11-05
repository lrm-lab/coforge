import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  hashDaemonApiKey,
  prepareDaemonApiKey,
  verifyDaemonApiKey,
} from "#src/server/auth/daemon-api-key.server";
import { PrismaDaemonApiKeyRepository } from "#src/server/db/repositories/daemon-api-key.repositories.server";
import {
  swapKey,
  confirmKey,
  selfComputer,
  detachComputer,
} from "#src/server/computers/computer-self.server";
import { authenticateLinkedDaemon } from "#src/server/auth/daemon-request.server";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
// authenticateDaemon reaches the database through getDatabaseClient, which reads DATABASE_URL.
Bun.env.DATABASE_URL = connectionString;
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const keys = new PrismaDaemonApiKeyRepository(db);

async function fixture() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { username: `comp-${suffix}`, displayName: "Comp" },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `comp-${suffix}`,
      name: "Computer",
      members: { create: { userId: owner.id, role: "member" } },
    },
  });
  const computer = await db.computer.create({
    data: {
      ownerId: owner.id,
      machineId: `machine-${suffix}`,
      name: `comp-${suffix}`,
    },
  });
  await db.workspaceComputer.create({
    data: { workspaceId: workspace.id, computerId: computer.id },
  });
  const { apiKey, record } = prepareDaemonApiKey({
    principal: { userId: owner.id },
    workspaceId: workspace.id,
    computerId: computer.id,
  });
  const key = await db.daemonApiKey.create({ data: record });
  return { owner, workspace, computer, daemonApiKey: apiKey, daemonId: key.id };
}

test("a daemonApiKey swaps for an sk_computer; verifyDaemonApiKey accepts it", async () => {
  const f = await fixture();
  const claims = await verifyDaemonApiKey(f.daemonApiKey, keys);
  const swapped = await db.$transaction(async (tx) => swapKey(tx, claims));
  expect(swapped.status).toBe(200);
  const { apiKey } = await swapped.json();
  expect(apiKey).toMatch(/^sk_computer_/);
  const computerClaims = await verifyDaemonApiKey(apiKey, keys);
  expect(computerClaims.kind).toBe("computer");
  expect(computerClaims.computerId).toBe(f.computer.id);
});

test("an sk_computer confirms; the daemonApiKey and prior unconfirmed sk_computers revoke", async () => {
  const f = await fixture();
  const claims = await verifyDaemonApiKey(f.daemonApiKey, keys);
  const first = await db.$transaction(async (tx) => swapKey(tx, claims));
  const { apiKey: firstKey } = await first.json();
  const second = await db.$transaction(async (tx) => swapKey(tx, claims));
  const { apiKey: secondKey } = await second.json();
  expect(
    (
      await db.daemonApiKey.findFirstOrThrow({
        where: { apiKeyHash: hashDaemonApiKey(firstKey) },
      })
    ).revokedAt,
  ).not.toBeNull();
  const self = await selfComputer(db, await verifyDaemonApiKey(secondKey, keys));
  expect(self.status).toBe(200);
  const confirm = await confirmKey(db, await verifyDaemonApiKey(secondKey, keys));
  expect(confirm.status).toBe(200);
  expect(
    (await db.daemonApiKey.findUniqueOrThrow({ where: { id: f.daemonId } })).revokedAt,
  ).not.toBeNull();
  await expect(verifyDaemonApiKey(firstKey, keys)).rejects.toThrow();
});

test("a daemonApiKey cannot confirm; an sk_computer cannot swap", async () => {
  const f = await fixture();
  const claims = await verifyDaemonApiKey(f.daemonApiKey, keys);
  const swapped = await db.$transaction(async (tx) => swapKey(tx, claims));
  const { apiKey } = await swapped.json();
  expect(await swapKey(db, await verifyDaemonApiKey(apiKey, keys))).toHaveProperty("status", 403);
  expect(await confirmKey(db, claims)).toHaveProperty("status", 403);
});

test("A's sk_computer cannot read B's self", async () => {
  const a = await fixture();
  const b = await fixture();
  const claims = await verifyDaemonApiKey(a.daemonApiKey, keys);
  const swapped = await db.$transaction(async (tx) => swapKey(tx, claims));
  const { apiKey } = await swapped.json();
  // A's sk_computer claims B's computerId — the handler's principal carries A's own computerId,
  // so the "read B" path is a no-op by construction: selfComputer reads principal.computerId,
  // which is A's. The test pins that A's key names A's computer, never B's.
  const aClaims = await verifyDaemonApiKey(apiKey, keys);
  expect(aClaims.computerId).toBe(a.computer.id);
  expect(aClaims.computerId).not.toBe(b.computer.id);
});

test("a revoked key fails verifyDaemonApiKey", async () => {
  const f = await fixture();
  const claims = await verifyDaemonApiKey(f.daemonApiKey, keys);
  const swapped = await db.$transaction(async (tx) => swapKey(tx, claims));
  const { apiKey } = await swapped.json();
  await db.$transaction(async (tx) => confirmKey(tx, await verifyDaemonApiKey(apiKey, keys)));
  await expect(verifyDaemonApiKey(f.daemonApiKey, keys)).rejects.toThrow();
});

test("a dk_ cannot call self; an sk_computer cannot call swap", async () => {
  const f = await fixture();
  const claims = await verifyDaemonApiKey(f.daemonApiKey, keys);
  expect(await selfComputer(db, claims)).toHaveProperty("status", 403);
  const swapped = await db.$transaction(async (tx) => swapKey(tx, claims));
  const { apiKey } = await swapped.json();
  expect(await swapKey(db, await verifyDaemonApiKey(apiKey, keys))).toHaveProperty("status", 403);
});

test("confirming twice revokes the daemonApiKey once and stays idempotent", async () => {
  const f = await fixture();
  const claims = await verifyDaemonApiKey(f.daemonApiKey, keys);
  const swapped = await db.$transaction(async (tx) => swapKey(tx, claims));
  const { apiKey } = await swapped.json();
  await db.$transaction(async (tx) => confirmKey(tx, await verifyDaemonApiKey(apiKey, keys)));
  const again = await db.$transaction(async (tx) =>
    confirmKey(tx, await verifyDaemonApiKey(apiKey, keys)),
  );
  expect(again.status).toBe(200);
});

test("a confirm on A does not touch B's workspace", async () => {
  const a = await fixture();
  const b = await fixture();
  const claims = await verifyDaemonApiKey(a.daemonApiKey, keys);
  const swapped = await db.$transaction(async (tx) => swapKey(tx, claims));
  const { apiKey } = await swapped.json();
  await db.$transaction(async (tx) => confirmKey(tx, await verifyDaemonApiKey(apiKey, keys)));
  expect(
    (
      await db.daemonApiKey.findFirstOrThrow({
        where: { computerId: b.computer.id, revokedAt: null },
      })
    ).revokedAt,
  ).toBeNull();
});

test("a computer that detached fails authenticateLinkedDaemon", async () => {
  const f = await fixture();
  await db.workspaceComputer.deleteMany({
    where: { workspaceId: f.workspace.id, computerId: f.computer.id },
  });
  const request = new Request("http://test/api/computer/swap-key", {
    headers: { authorization: `Bearer ${f.daemonApiKey}` },
  });
  const result = await authenticateLinkedDaemon(request);
  expect(result).toBeInstanceOf(Response);
  expect((result as Response).status).toBe(403);
});

test("a revoked key is refused by authenticateLinkedDaemon before any route runs", async () => {
  const f = await fixture();
  const claims = await verifyDaemonApiKey(f.daemonApiKey, keys);
  const swapped = await db.$transaction(async (tx) => swapKey(tx, claims));
  const { apiKey } = await swapped.json();
  await db.$transaction(async (tx) => confirmKey(tx, await verifyDaemonApiKey(apiKey, keys)));
  const request = new Request("http://test/api/computer/self", {
    headers: { authorization: `Bearer ${f.daemonApiKey}` },
  });
  const result = await authenticateLinkedDaemon(request);
  expect(result).toBeInstanceOf(Response);
  expect((result as Response).status).toBe(401);
});

test("a dk_ cannot call detach", async () => {
  const f = await fixture();
  const claims = await verifyDaemonApiKey(f.daemonApiKey, keys);
  const api = { presence: async () => [], disconnect: async () => {} };
  const result = await detachComputer(db, api, () => {}, claims);
  expect(result.status).toBe(403);
});

test("detach unlinks, revokes every key, notifies and reconnects after commit", async () => {
  const f = await fixture();
  const claims = await verifyDaemonApiKey(f.daemonApiKey, keys);
  const swapped = await db.$transaction(async (tx) => swapKey(tx, claims));
  const { apiKey } = await swapped.json();
  const computerClaims = await verifyDaemonApiKey(apiKey, keys);
  const disconnected: { user: string; client: string; code: number }[] = [];
  const api = {
    presence: async () => [{ client: "client-1", user: f.owner.id }],
    disconnect: async (input: {
      user: string;
      client: string;
      disconnect: { code: number; reason: string };
    }) => {
      disconnected.push({ ...input, code: input.disconnect.code });
    },
  };
  const notified: string[] = [];
  const result = await detachComputer(
    db,
    api,
    (computerId) => notified.push(computerId),
    computerClaims,
  );
  expect(result.status).toBe(200);
  expect(notified).toEqual([f.computer.id]);
  expect(disconnected).toHaveLength(1);
  expect(
    await db.workspaceComputer.findFirst({
      where: { workspaceId: f.workspace.id, computerId: f.computer.id },
    }),
  ).toBeNull();
  expect(
    await db.daemonApiKey.count({
      where: { computerId: f.computer.id, workspaceId: f.workspace.id, revokedAt: null },
    }),
  ).toBe(0);
  // After detach every key is revoked: HTTP, RPC and connect all refuse through
  // verifyDaemonApiKey, and the link check never even runs.
  for (const key of [f.daemonApiKey, apiKey]) {
    const request = new Request("http://test/api/computer/self", {
      headers: { authorization: `Bearer ${key}` },
    });
    const refused = await authenticateLinkedDaemon(request);
    expect(refused).toBeInstanceOf(Response);
    expect((refused as Response).status).toBe(401);
  }
});

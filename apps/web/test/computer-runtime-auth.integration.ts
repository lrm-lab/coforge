import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  parseStoredRuntimeAuth,
  PrismaComputerRuntimeAuthStore,
  storedRuntimeAuth,
} from "#src/server/computers/computer-runtime-auth.server";

// A Computer keeps the newest runtime login report its daemon sent, whatever order they arrive in.
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const store = new PrismaComputerRuntimeAuthStore(db);
const username = `cra-${crypto.randomUUID().slice(0, 8)}`;
let computerId: string;

const stored = async (): Promise<unknown> =>
  parseStoredRuntimeAuth(
    (await db.computer.findUniqueOrThrow({ where: { id: computerId } })).runtimeAuth,
  );

beforeAll(async () => {
  const owner = await db.user.create({ data: { username, displayName: username } });
  computerId = (await db.computer.create({ data: { ownerId: owner.id, machineId: username } })).id;
});

afterAll(async () => {
  await db.computer.deleteMany({ where: { id: computerId } });
  await db.user.deleteMany({ where: { username } });
  await db.$disconnect();
});

test("the first report fills the column, a newer one replaces it, an older one is ignored", async () => {
  expect(await stored()).toBeNull();

  const first = storedRuntimeAuth(2_000, [{ provider: "codex", state: "logged_out" }]);
  expect(await store.record(computerId, first)).toBe(true);
  expect(await stored()).toEqual(first);

  const older = storedRuntimeAuth(1_000, [{ provider: "codex", state: "logged_in" }]);
  expect(await store.record(computerId, older)).toBe(false);
  expect(await stored()).toEqual(first);

  const newer = storedRuntimeAuth(3_000, [
    { provider: "codex", state: "logged_in", account: { maskedLabel: "a***@example.com" } },
    { provider: "claude-code", state: "unavailable", unavailableReason: "not_installed" },
  ]);
  expect(await store.record(computerId, newer)).toBe(true);
  expect(await stored()).toEqual(newer);
});

test("a Computer that does not exist records nothing", async () => {
  expect(await store.record(crypto.randomUUID(), storedRuntimeAuth(1, []))).toBe(false);
});

test("the database preserves an unknown provider while display reads still hide it", async () => {
  const report = storedRuntimeAuth(4_000, [
    { provider: "future-cli", state: "logged_in", account: { maskedLabel: "f***@example.com" } },
    { provider: "kiro", state: "logged_in", account: { methodLabel: "IAM Identity Center" } },
  ]);
  expect(await store.record(computerId, report)).toBe(true);
  const column = (await db.computer.findUniqueOrThrow({ where: { id: computerId } })).runtimeAuth;
  expect(column).toEqual(report);
  expect(await stored()).toEqual({
    collectedAtMs: 4_000,
    runtimes: { kiro: report.runtimes.kiro },
  });
});

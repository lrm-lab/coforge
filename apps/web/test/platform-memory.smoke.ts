import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { platformMemory } from "#src/server/platform-memory/composition.server";
import { savePlatformMemoryPreference } from "#src/server/db/repositories/platform-memory-preferences.repositories.server";
import type { MemoryActor } from "#src/server/platform-memory/contract";

if (Bun.env.PLATFORM_MEMORY_REAL_SMOKE !== "1")
  throw new Error("Explicit PLATFORM_MEMORY_REAL_SMOKE=1 is required");
const baseUrl = Bun.env.COFORGE_OPENVIKING_URL;
const conf = Bun.env.OPENVIKING_PLATFORM_SMOKE_CONF;
const databaseUrl = Bun.env.PLATFORM_MEMORY_TEST_DATABASE_URL;
if (!Bun.env.OPENVIKING_RUNTIME_IDENTITY)
  throw new Error(
    "OPENVIKING_RUNTIME_IDENTITY must record the inspected real service image/version",
  );
if (!baseUrl || !conf || !databaseUrl)
  throw new Error(
    "Set the real engine URL, protected server config path and disposable PostgreSQL URL",
  );
const database = new URL(databaseUrl);
if (
  !["127.0.0.1", "localhost"].includes(database.hostname) ||
  !database.pathname.startsWith("/memory_")
)
  throw new Error("Use a loopback disposable memory_* database; production metadata is forbidden");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const work = await mkdtemp(join(tmpdir(), "coforge-platform-real-"));
const keyPath = join(work, "accounts.json");
const output = Bun.env.PLATFORM_MEMORY_REAL_SMOKE_OUTPUT ?? join(work, "results.json");
const accounts: string[] = [];
const workspaces: string[] = [];
const users: string[] = [];
const agents: { id: string; workspaceId: string; ownerId: string }[] = [];
const steps: string[] = [];
const keys: Record<string, string> = {};
let rootKey = "";
const originalKeyPath = Bun.env.COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE;

async function admin(method: string, path: string, body?: unknown) {
  return fetch(new URL(path, baseUrl), {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: {
      authorization: `Bearer ${rootKey}`,
      "X-OpenViking-Account": "root",
      "X-OpenViking-User": "platform-smoke-root",
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function record(step: string) {
  steps.push(step);
  await Bun.write(
    output,
    JSON.stringify(
      {
        sourceCommit: Bun.env.PLATFORM_MEMORY_SMOKE_REVISION ?? "working-tree",
        runtimeIdentity: Bun.env.OPENVIKING_RUNTIME_IDENTITY ?? "unverified",
        baseUrl,
        accounts,
        workspaces,
        steps,
        scope:
          "PR PlatformMemory service, real PostgreSQL, production binding resolver and real OpenViking. No synthetic engine responses.",
      },
      null,
      2,
    ),
  );
  console.log(`PASS ${step}`);
}

beforeAll(async () => {
  const config = JSON.parse(await Bun.file(conf).text()) as { server?: { root_api_key?: string } };
  if (!config.server?.root_api_key)
    throw new Error("The protected runtime config has no root API key");
  rootKey = config.server.root_api_key;
  for (let i = 0; i < 3; i++)
    users.push(
      (
        await db.user.create({
          data: {
            username: `pr517-real-${crypto.randomUUID()}`,
            displayName: "Synthetic memory evaluator",
          },
        })
      ).id,
    );
  for (let i = 0; i < 2; i++) {
    const accountId = `pr517-${crypto.randomUUID()}`;
    accounts.push(accountId);
    const response = await admin("POST", "/api/v1/admin/accounts", {
      account_id: accountId,
      admin_user_id: "coforge-platform-memory",
    });
    if (!response.ok) throw new Error(`Isolated account provisioning HTTP ${response.status}`);
    const payload = (await response.json()) as { result?: { user_key?: string } };
    if (!payload.result?.user_key) throw new Error("Isolated account has no ADMIN key");
    const reference = `secret:${accountId}`;
    keys[reference] = payload.result.user_key;
    const workspace = await db.workspace.create({
      data: {
        slug: `pr517-${crypto.randomUUID()}`,
        name: "Synthetic real-engine acceptance",
        members: {
          create: users.map((userId, at) => ({ userId, role: at === 1 ? "admin" : "member" })),
        },
      },
    });
    workspaces.push(workspace.id);
    await db.openVikingBinding.create({
      data: {
        workspaceId: workspace.id,
        accountId,
        serviceIdentityId: "coforge-platform-memory",
        credentialRef: reference,
        generation: 1,
      },
    });
    for (const ownerId of users)
      agents.push(
        await db.agent.create({
          data: {
            workspaceId: workspace.id,
            ownerId,
            name: `fixture-${ownerId}`,
            displayName: "Synthetic evaluator",
            runtimeConfig: { runtime: "codex" },
          },
          select: { id: true, workspaceId: true, ownerId: true },
        }),
      );
  }
  await Bun.write(keyPath, JSON.stringify(keys));
  await chmod(keyPath, 0o600);
  Bun.env.COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE = keyPath;
}, 120000);

afterAll(async () => {
  const cleanup: { accountId: string; status: number }[] = [];
  for (const accountId of accounts) {
    const response = await admin("DELETE", `/api/v1/admin/accounts/${accountId}`).catch(
      () => undefined,
    );
    const status = response?.status ?? 0;
    cleanup.push({ accountId, status });
    await response?.body?.cancel();
  }
  await db.workspace.deleteMany({ where: { id: { in: workspaces } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
  if (originalKeyPath === undefined) delete Bun.env.COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE;
  else Bun.env.COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE = originalKeyPath;
  await rm(keyPath, { force: true });
  await Bun.write(output + ".cleanup.json", JSON.stringify(cleanup, null, 2));
  expect(cleanup.every(({ status }) => [200, 202, 204, 404].includes(status))).toBe(true);
}, 120000);

test("new platform memory CRUD, semantic retrieval, sharing and live authorization against real OpenViking", async () => {
  const owner = agents[0]!;
  const adminAgent = agents[1]!;
  const memberAgent = agents[2]!;
  const foreignAgent = agents[3]!;
  const actor = (agent: typeof owner): MemoryActor => ({
    kind: "agent",
    workspaceId: agent.workspaceId,
    agentId: agent.id,
  });
  const call = () => platformMemory(db);
  const a = actor(owner);
  expect(await call().execute(a, { operation: "status" })).toMatchObject({
    enabled: true,
    available: true,
  });
  const created = (
    await call().execute(a, {
      operation: "create",
      scope: "agent",
      requestId: crypto.randomUUID(),
      title: "Synthetic release decision",
      kind: "fact",
      content:
        "PR517 seafoam release procedure: run the automated tests before publishing the seafoam application.",
    })
  ).entries[0]!;
  expect(created.content).toContain("automated tests");
  expect((await call().execute(a, { operation: "get", id: created.id })).entries[0]?.content).toBe(
    created.content,
  );
  await record("create and read through production service/binding resolver");
  const found = await call().execute(a, {
    operation: "search",
    query: "What must happen before the seafoam application is published?",
  });
  expect(found.entries.some((entry) => entry.id === created.id)).toBe(true);
  await record("semantic search retrieves the created fact");
  await expect(
    call().execute(actor(adminAgent), { operation: "get", id: created.id }),
  ).rejects.toThrow("memory_not_found");
  await expect(
    call().execute(
      { kind: "user", workspaceId: owner.workspaceId, userId: users[1]! },
      { operation: "get", id: created.id },
    ),
  ).rejects.toThrow("memory_not_found");
  await expect(
    call().execute(actor(foreignAgent), { operation: "get", id: created.id }),
  ).rejects.toThrow("memory_not_found");
  await record("another Agent, Workspace admin and another Workspace cannot read personal memory");
  const edited = (
    await call().execute(a, {
      operation: "update",
      id: created.id,
      revision: created.revision,
      requestId: crypto.randomUUID(),
      title: created.title,
      kind: "fact",
      content:
        "PR517 seafoam release procedure: run tests AND the production build before publishing.",
    })
  ).entries[0]!;
  expect(edited.revision).toBe(created.revision + 1);
  expect((await call().execute(a, { operation: "get", id: created.id })).entries[0]?.content).toBe(
    edited.content,
  );
  expect(
    (
      await call().execute(a, {
        operation: "search",
        query: "seafoam release tests and production build",
      })
    ).entries.some((entry) => entry.id === created.id && entry.content === edited.content),
  ).toBe(true);
  await record("update activates and retrieves the corrected revision");
  const shared = (
    await call().execute(a, {
      operation: "share",
      id: edited.id,
      revision: edited.revision,
      requestId: crypto.randomUUID(),
    })
  ).entries[0]!;
  expect(
    (await call().execute(actor(memberAgent), { operation: "get", id: shared.id })).entries[0]
      ?.content,
  ).toBe(edited.content);
  expect(
    (
      await call().execute(actor(memberAgent), {
        operation: "search",
        scope: "team",
        query: "seafoam production build",
      })
    ).entries.some((entry) => entry.id === shared.id),
  ).toBe(true);
  await expect(
    call().execute(actor(memberAgent), {
      operation: "delete",
      id: shared.id,
      revision: shared.revision,
      requestId: crypto.randomUUID(),
    }),
  ).rejects.toThrow("memory_forbidden");
  await record("explicit sharing is readable by teammates and rejects an unauthorized delete");
  await savePlatformMemoryPreference(db, owner.ownerId, false);
  expect((await call().execute(a, { operation: "status" })).enabled).toBe(false);
  await expect(call().execute(a, { operation: "get", id: edited.id })).rejects.toThrow(
    "memory_disabled",
  );
  expect(
    (
      await call().execute(
        { kind: "user", workspaceId: owner.workspaceId, userId: owner.ownerId },
        { operation: "get", id: edited.id },
      )
    ).entries[0]?.content,
  ).toBe(edited.content);
  await savePlatformMemoryPreference(db, owner.ownerId, true);
  await record("personal opt-out blocks Agent requests and preserves human management");
  await call().execute(a, {
    operation: "delete",
    id: edited.id,
    revision: edited.revision,
    requestId: crypto.randomUUID(),
  });
  await expect(call().execute(a, { operation: "get", id: edited.id })).rejects.toThrow(
    "memory_not_found",
  );
  expect(
    (await call().execute(a, { operation: "search", query: "seafoam release" })).entries.some(
      (entry) => entry.id === edited.id,
    ),
  ).toBe(false);
  await call().execute(a, {
    operation: "delete",
    id: shared.id,
    revision: shared.revision,
    requestId: crypto.randomUUID(),
  });
  await record("delete excludes personal/team entries from reads and semantic retrieval");
}, 180000);

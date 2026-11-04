import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import {
  authenticateAgentApiKey,
  createAgentApiKey,
  hashAgentApiKey,
  type AgentApiKeyRepository,
} from "#src/server/agents/agent-api-key.server";
import { moveAgentToComputer } from "#src/server/db/repositories/agent.repositories.server";
import { PrismaAgentApiKeyRepository } from "#src/server/db/repositories/agent-api-key.repositories.server";

/**
 * The overlap-rotation rules against real PostgreSQL: insertion order, the conditional
 * updates and the Agent row lock are what the in-memory fake cannot reproduce.
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const db = connectionString
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  : undefined;

const suffixes: string[] = [];

async function fixture() {
  const suffix = crypto.randomUUID().slice(0, 8);
  suffixes.push(suffix);
  const owner = await db!.user.create({
    data: { displayName: `k-${suffix}`, username: `k-${suffix}` },
  });
  const workspace = await db!.workspace.create({
    data: { slug: `k-${suffix}`, name: "Key rotation" },
  });
  const computer = async (label: string) =>
    db!.computer.create({ data: { ownerId: owner.id, machineId: `${label}-${suffix}` } });
  const computerA = await computer("a");
  const computerB = await computer("b");
  const agent = await db!.agent.create({
    data: {
      workspaceId: workspace.id,
      name: `agent-${suffix}`,
      displayName: "Key Agent",
      ownerId: owner.id,
      computerId: computerA.id,
      runtimeConfig: {},
    },
  });
  const repository: AgentApiKeyRepository = new PrismaAgentApiKeyRepository(db!);
  const mint = (computerId: string) =>
    createAgentApiKey({
      agentId: agent.id,
      workspaceId: workspace.id,
      ownerId: owner.id,
      computerId,
      repository,
    });
  const activeHashes = async () =>
    db!.agentApiKey.findMany({
      where: { agentId: agent.id, revokedAt: null },
      select: { apiKeyHash: true, computerId: true },
      orderBy: { createdAt: "asc" },
    });
  return { agent, computerA, computerB, repository, mint, activeHashes };
}

describe.skipIf(!db)("PrismaAgentApiKeyRepository", () => {
  afterEach(async () => {
    for (const suffix of suffixes.splice(0)) {
      await db!.workspace.deleteMany({ where: { slug: `k-${suffix}` } });
      await db!.computer.deleteMany({ where: { machineId: { endsWith: `-${suffix}` } } });
      await db!.user.deleteMany({ where: { username: `k-${suffix}` } });
    }
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  test("rotate keeps only the newest prior key until the new key authenticates", async () => {
    const f = await fixture();
    const first = await f.mint(f.computerA.id);
    const second = await f.mint(f.computerA.id);
    const third = await f.mint(f.computerA.id);

    // After the third mint only the two newest stay active — the oldest was revoked at mint.
    expect((await f.activeHashes()).length).toBe(2);
    await expect(authenticateAgentApiKey(first, f.repository)).rejects.toThrow(
      "invalid Agent API key",
    );
    await expect(authenticateAgentApiKey(second, f.repository)).resolves.toMatchObject({
      computerId: f.computerA.id,
    });
    // The second key's first authentication retired nothing newer: the third is untouched.
    await expect(authenticateAgentApiKey(third, f.repository)).resolves.toMatchObject({
      computerId: f.computerA.id,
    });
    expect((await f.activeHashes()).length).toBe(1);
  });

  test("a key revoked before its first use does not resurrect the older key on the next mint", async () => {
    const f = await fixture();
    const first = await f.mint(f.computerA.id);
    const second = await f.mint(f.computerA.id);
    const secondId = (
      await db!.agentApiKey.findUniqueOrThrow({
        where: { apiKeyHash: hashAgentApiKey(second) },
      })
    ).id;
    // The second key is revoked before it ever authenticates — a Stop or a failed launch.
    await f.repository.revoke(secondId);
    const third = await f.mint(f.computerA.id);

    await expect(authenticateAgentApiKey(first, f.repository)).rejects.toThrow(
      "invalid Agent API key",
    );
    await expect(authenticateAgentApiKey(second, f.repository)).rejects.toThrow(
      "invalid Agent API key",
    );
    await expect(authenticateAgentApiKey(third, f.repository)).resolves.toBeTruthy();
    expect((await f.activeHashes()).length).toBe(1);
  });

  test("revoking one key drops only that key; the all scope ends the Agent's keys", async () => {
    const f = await fixture();
    const first = await f.mint(f.computerA.id);
    const second = await f.mint(f.computerA.id);
    const secondRow = await db!.agentApiKey.findUniqueOrThrow({
      where: { apiKeyHash: hashAgentApiKey(second) },
    });
    await f.repository.revoke(secondRow.id);

    // A failed launch's own revoke leaves the still-running overlap key untouched.
    expect((await f.activeHashes()).length).toBe(1);
    await expect(authenticateAgentApiKey(first, f.repository)).resolves.toBeTruthy();
    await expect(authenticateAgentApiKey(second, f.repository)).rejects.toThrow(
      "invalid Agent API key",
    );

    await f.repository.revokeAll(secondRow);
    expect((await f.activeHashes()).length).toBe(0);
    await expect(authenticateAgentApiKey(first, f.repository)).rejects.toThrow(
      "invalid Agent API key",
    );
  });

  test("a mint on a new Computer keeps no earlier key of another Computer", async () => {
    const f = await fixture();
    const moved = await f.mint(f.computerA.id);
    const current = await f.mint(f.computerB.id);

    expect(await f.activeHashes()).toEqual([
      expect.objectContaining({ computerId: f.computerB.id }),
    ]);
    await expect(authenticateAgentApiKey(moved, f.repository)).rejects.toThrow(
      "invalid Agent API key",
    );
    await expect(authenticateAgentApiKey(current, f.repository)).resolves.toBeTruthy();
  });

  test("moving the Agent to another Computer revokes its keys at once", async () => {
    const f = await fixture();
    const moved = await f.mint(f.computerA.id);

    await db!.$transaction(async (tx) => {
      expect(
        await moveAgentToComputer(tx, {
          agentId: f.agent.id,
          fromComputerId: f.computerA.id,
          toComputerId: f.computerB.id,
        }),
      ).toBe(true);
    });

    expect((await f.activeHashes()).length).toBe(0);
    await expect(authenticateAgentApiKey(moved, f.repository)).rejects.toThrow(
      "invalid Agent API key",
    );
  });
});

import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { agentWakeBlock, PrismaAgentWakeBlocks } from "#src/server/agents/agent-wake-block.server";
import { workspaceWithAgent } from "./support/agent-inbox-fixture";
import { createMigratedScratchDatabase, type ScratchDatabase } from "./support/scratch-database";

const base = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!base) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");

test("messages counted in one stop are not counted again after the next stop", async () => {
  let scratch: ScratchDatabase | undefined;
  let db: PrismaClient | undefined;
  try {
    scratch = await createMigratedScratchDatabase(base, "wake_block");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: scratch.url }) });
    const { agent } = await workspaceWithAgent(db, `wb-${crypto.randomUUID().slice(0, 8)}`);
    const writer = new PrismaAgentWakeBlocks(db);
    const select = {
      where: { id: agent.id },
      select: { wakeBlockedReason: true, wakeBlockedCount: true, wakeBlockedAt: true },
    } as const;

    const firstStop = new Date(Date.now() - 60_000);
    await db.agent.update({ where: { id: agent.id }, data: { stoppedAt: firstStop } });
    await writer.record(agent.id, "stopped", firstStop);
    await writer.record(agent.id, "stopped", firstStop);
    expect((await db.agent.findUniqueOrThrow(select)).wakeBlockedCount).toBe(2);

    await Bun.sleep(20);
    const secondStop = new Date();
    await db.agent.update({ where: { id: agent.id }, data: { stoppedAt: secondStop } });
    await writer.record(agent.id, "stopped", secondStop);

    const row = await db.agent.findUniqueOrThrow(select);
    expect(row.wakeBlockedCount).toBe(1);
    expect(agentWakeBlock(row, { stopped: true, stoppedAt: secondStop })).toEqual({
      reason: "stopped",
      messageCount: 1,
      at: row.wakeBlockedAt!,
    });
  } finally {
    await db?.$disconnect();
    await scratch?.drop();
  }
}, 120_000);

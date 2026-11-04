import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { noteAgentRuntimeQuotaNotice } from "#src/server/agents/agent-runtime-quota-notice.server";
import { agentDirectKey } from "#src/features/conversations/direct-key";

test("a no-reset quota leaves one system message in the owner's DM, deduped by fingerprint", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({
    data: { displayName: `u${suffix}`, username: `u${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: { slug: suffix, name: "Quota notice", members: { create: { userId: user.id } } },
  });
  try {
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        name: `devin-${suffix}`,
        displayName: "Devin",
        visibility: "public",
        runtimeConfig: { runtime: "devin" },
      },
    });
    // The owner↔agent DM the notice belongs in.
    const dm = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        directKey: agentDirectKey(user.id, agent.id),
      },
    });
    await noteAgentRuntimeQuotaNotice(db, {
      workspaceId: workspace.id,
      agentId: agent.id,
      fingerprint: "fp-1",
    });
    const messages = await db.message.findMany({
      where: { conversationId: dm.id },
      include: { systemMessage: true },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toContain("Devin");
    expect(messages[0]!.body).toContain("quota");
    expect(messages[0]!.systemMessage?.kind).toBe("agent_runtime.quota_exhausted");

    // The same episode observed again (same fingerprint) does not re-tell.
    await noteAgentRuntimeQuotaNotice(db, {
      workspaceId: workspace.id,
      agentId: agent.id,
      fingerprint: "fp-1",
    });
    expect(await db.message.count({ where: { conversationId: dm.id } })).toBe(1);

    // A different episode (new fingerprint) is told again.
    await noteAgentRuntimeQuotaNotice(db, {
      workspaceId: workspace.id,
      agentId: agent.id,
      fingerprint: "fp-2",
    });
    expect(await db.message.count({ where: { conversationId: dm.id } })).toBe(2);
  } finally {
    await db.$disconnect();
  }
});

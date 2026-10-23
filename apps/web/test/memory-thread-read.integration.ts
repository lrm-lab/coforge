import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { Pool } from "pg";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { enrollGeneralChannel } from "#src/server/conversations/general-channel.server";
import { readAgentMessages } from "#src/server/agents/agent-messages.server";
import { resolveMemoryDiagnosisScope } from "#src/server/workspace-memory/memory-diagnosis-scope.server";
import { AgentMessageAttentionIndex } from "../../../packages/daemon/src/daemon-runtime/agent-message-attention-index";
import { AgentMessageOperations } from "../../../packages/daemon/src/daemon-runtime/agent-message-operations";

test("a Task thread follow-up remains readable and can anchor autonomous diagnosis after a wrong parent read", async () => {
  const connectionString = Bun.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required (local PostgreSQL)");
  const schemaFile = Bun.env.MEMORY_THREAD_TEST_SCHEMA_SQL;
  if (!schemaFile)
    throw new Error(
      "MEMORY_THREAD_TEST_SCHEMA_SQL must contain Prisma migrate diff --from-empty --script output",
    );
  const ddl = await Bun.file(schemaFile).text();
  if (!ddl.includes('CREATE TABLE "users"')) throw new Error("Invalid branch schema fixture");
  const suffix = crypto.randomUUID();
  const schema = `memory_thread_${suffix.replaceAll("-", "")}`;
  const pool = new Pool({ connectionString, max: 1 });
  const sql = await pool.connect();
  const db = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString, options: `-c search_path=${schema},public` },
      { schema },
    ),
  });
  try {
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`SET search_path TO "${schema}", public`);
    await sql.query(ddl.replace('CREATE SCHEMA IF NOT EXISTS "public";', ""));
    const user = await db.user.create({
      data: { username: `mt${suffix.slice(0, 8)}`, displayName: "Thread test" },
    });
    const workspace = await db.workspace.create({
      data: {
        slug: suffix,
        name: "Memory thread regression",
        members: { create: { userId: user.id } },
      },
    });
    const agents = [];
    for (const name of ["memory", "task"])
      agents.push(
        await db.agent.create({
          data: {
            workspaceId: workspace.id,
            ownerId: user.id,
            name,
            displayName: name,
            runtimeConfig: {},
          },
        }),
      );
    const [memory, task] = agents;
    const general = await enrollGeneralChannel(db, workspace.id);
    const channels = new PublicChannels(db, { execute: async (_scope, persist) => persist() });
    const root = await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "Identify the director and the debut series from documents.",
    });
    const repo = new PrismaDirectConversationRepository(db);
    const followup = await repo.sendAgentMessage(
      general.id,
      task!.id,
      "@memory The previous queries failed and I still cannot verify the director. Try a different method.",
      undefined,
      root.id,
    );
    const thread = `#general:${root.id}`;
    const attention = new AgentMessageAttentionIndex(
      workspace.id,
      {
        session: () => ({
          notify: async () => {},
          sendMessage: async () => {},
          subscribe: () => () => {},
          onExit: () => () => {},
          interrupt: async () => {},
          dispose: async () => {},
        }),
      },
      async () => {},
    );
    await attention.receive({
      protocolMajor: 1,
      requestId: "thread-regression",
      deliveryId: "thread-regression",
      messageId: followup.id,
      workspaceId: workspace.id,
      conversationId: general.id,
      agentId: memory!.id,
      target: thread,
      sequence: followup.sequence,
      body: followup.body,
      mentionsAgent: true,
      method: "agent:v1:message:deliver",
    });
    const operations = new AgentMessageOperations({
      connection: { workspaceId: workspace.id, computerId: "integration" },
      attention,
      isMemoryAgent: (id) => id === memory!.id,
      inbox: () => {
        throw new Error("read only");
      },
      reportFreshnessHold: () => {},
      transport: {
        agentMessage: async (request) => ({
          protocolMajor: 1,
          accepted: true,
          attentionCount: 0,
          ...(await readAgentMessages(
            repo,
            { workspaceId: workspace.id, agentId: request.agentId },
            request.target,
            {},
          )),
          idempotencyKey: request.idempotencyKey,
        }),
      },
    });
    const read = (target: string) =>
      operations.handle(
        memory!.id,
        { idempotencyKey: crypto.randomUUID(), context: "integration", operation: "read", target },
        target,
        "integration",
      );
    await expect(read("#general")).rejects.toThrow(thread);
    expect(attention.check(memory!.id).map((item) => item.target)).toEqual([thread]);
    const found = await read(thread);
    expect(found.messages.map((message) => message.id)).toContain(followup.id);
    expect(found.messages.find((message) => message.id === followup.id)?.body).toContain(
      "previous queries failed",
    );
    expect((await read(thread)).messages).toHaveLength(0);
    expect((await read("#general")).accepted).toBe(true);
    const scope = await resolveMemoryDiagnosisScope(db, {
      workspaceId: workspace.id,
      agentId: memory!.id,
      messageId: followup.id,
    });
    expect(scope.triggerKind).toBe("task_state");
    expect(scope.targetAgentId).toBe(task!.id);
    expect(scope.messages.flatMap((message) => message.sourceMessageIds)).toEqual([
      root.id,
      followup.id,
    ]);
    await expect(
      resolveMemoryDiagnosisScope(db, {
        workspaceId: workspace.id,
        agentId: task!.id,
        messageId: followup.id,
      }),
    ).rejects.toThrow("diagnosis_scope_denied");
  } finally {
    await db.$disconnect();
    await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    sql.release();
    await pool.end();
  }
}, 15000);

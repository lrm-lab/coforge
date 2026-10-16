import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaMemoryDispositionStore } from "#src/server/db/repositories/memory-disposition.repositories.server";
import { handleMemoryDispositionHttp } from "#src/server/workspace-memory/memory-disposition-http.server";
import { createMemoryDispositions } from "#src/server/workspace-memory/memory-dispositions.server";

test("a disposition authorizes and commits with one PostgreSQL connection", async () => {
  const connectionString = Bun.env.DATABASE_URL;
  const fixture = Bun.env.MEMORY_THREAD_TEST_SCHEMA_SQL;
  if (!connectionString || !fixture)
    throw new Error("PostgreSQL and branch schema fixture required");
  const schema = `receipt_pool_${crypto.randomUUID().replaceAll("-", "")}`;
  const setup = new Pool({ connectionString, max: 1 });
  const sql = await setup.connect();
  const db = new PrismaClient({
    adapter: new PrismaPg(
      {
        connectionString,
        max: 1,
        connectionTimeoutMillis: 750,
        options: `-c search_path=${schema},public`,
      },
      { schema },
    ),
  });
  try {
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`SET search_path TO "${schema}", public`);
    await sql.query(
      (await Bun.file(fixture).text()).replace('CREATE SCHEMA IF NOT EXISTS "public";', ""),
    );
    const owner = await db.user.create({ data: { username: schema, displayName: "Receipt test" } });
    const workspace = await db.workspace.create({ data: { slug: schema, name: "Receipt test" } });
    const channel = await db.conversation.create({
      data: { workspaceId: workspace.id, channelName: "receipt" },
    });
    const agents: { id: string }[] = [];
    for (const name of ["task", "memory"])
      agents.push(
        await db.agent.create({
          data: {
            workspaceId: workspace.id,
            ownerId: owner.id,
            name,
            displayName: name,
            runtimeConfig: {},
          },
        }),
      );
    const source = {
      kind: "openviking" as const,
      workspaceId: workspace.id,
      matchedLevel: "L2" as const,
      citationId: "ov:viking://resources/evidence.md",
      accountId: "account",
      uri: "viking://resources/evidence.md",
    };
    const store = new PrismaMemoryDispositionStore(db, (tx) => ({
      async isMemoryAgent() {
        await tx.$queryRaw`SELECT 1`;
        return false;
      },
      async canReadSource() {
        await tx.$queryRaw`SELECT 1`;
        return true;
      },
    }));
    const hint = await store.prepare({
      workspaceId: workspace.id,
      operationId: "receipt-test",
      targetAgentId: agents[0]!.id,
      memoryAgentId: agents[1]!.id,
      conversationId: channel.id,
      body: "Grounded evidence",
      citations: [source],
      ttlMilliseconds: 300_000,
    });
    await db.memoryHintRecord.update({
      where: { id: hint.hint_id },
      data: { deliveredAt: new Date(), expiresAt: new Date(Date.now() + 300_000) },
    });
    const service = createMemoryDispositions({
      store,
      async isMemoryAgent() {
        await db.$queryRaw`SELECT 1`;
        return false;
      },
      async canReadSource() {
        await db.$queryRaw`SELECT 1`;
        return true;
      },
    });
    const request = { hint_id: hint.hint_id, decision: "adopt", reason: "Verified source" };
    const result = await service.submit(workspace.id, agents[0]!.id, request);
    expect(result.ok).toBe(true);
    expect(await service.submit(workspace.id, agents[0]!.id, request)).toMatchObject({
      ok: true,
      duplicate: true,
    });
    expect(await db.memoryDispositionEvent.count({ where: { hintId: hint.hint_id } })).toBe(1);
    await db.workspaceMemoryProfile.create({
      data: { workspaceId: workspace.id, desired: "openviking", observed: "ready", generation: 1 },
    });
    await db.openVikingBinding.create({
      data: {
        workspaceId: workspace.id,
        accountId: "account",
        serviceIdentityId: "receipt-service",
        credentialRef: "secret:receipt-integration",
        generation: 1,
      },
    });
    const next = await store.prepare({
      workspaceId: workspace.id,
      operationId: "http-receipt-test",
      targetAgentId: agents[0]!.id,
      memoryAgentId: agents[1]!.id,
      conversationId: channel.id,
      body: "Grounded evidence",
      citations: [source],
      ttlMilliseconds: 300_000,
    });
    await db.memoryHintRecord.update({
      where: { id: next.hint_id },
      data: { deliveredAt: new Date(), expiresAt: new Date(Date.now() + 300_000) },
    });
    let checkedIdentity = false;
    const backend = Bun.serve({
      port: 0,
      fetch(request) {
        checkedIdentity =
          request.headers.get("x-openviking-account") === "account" &&
          request.headers.get("x-openviking-user") === `agent:${agents[0]!.id}`;
        return Response.json({ status: "ok", result: {} });
      },
    });
    const saved = Object.fromEntries(
      [
        "COFORGE_OPENVIKING_URL",
        "COFORGE_OPENVIKING_RUNTIME_TOKEN",
        "COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE",
      ].map((key) => [key, Bun.env[key]]),
    );
    try {
      Bun.env.COFORGE_OPENVIKING_URL = backend.url.toString();
      Bun.env.COFORGE_OPENVIKING_RUNTIME_TOKEN = "integration-credential";
      delete Bun.env.COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE;
      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          handleMemoryDispositionHttp({
            db,
            workspaceId: workspace.id,
            agentId: agents[0]!.id,
            body: { hint_id: next.hint_id, decision: "adopt", reason: "Current ACL verified" },
          }),
        ),
      );
      const receipts = await Promise.all(responses.map((response) => response.json()));
      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(receipts.every((receipt) => receipt.ok)).toBe(true);
      expect(receipts.filter((receipt) => !receipt.duplicate)).toHaveLength(1);
      expect(checkedIdentity).toBe(true);
    } finally {
      await backend.stop(true);
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete Bun.env[key];
        else Bun.env[key] = value;
      }
    }
  } finally {
    await db.$disconnect();
    await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    sql.release();
    await setup.end();
  }
}, 15_000);

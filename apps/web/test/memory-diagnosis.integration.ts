import { expect, test } from "bun:test";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { resolveMemoryDiagnosisScope } from "#src/server/workspace-memory/memory-diagnosis-scope.server";

// Explicit integration entry: always uses isolated PostgreSQL, never skips silently.
test("Memory can diagnose an observed Task state only within its live channel and snapshot", async () => {
  const connectionString = Bun.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for diagnosis integration");
  const pool = new Pool({ connectionString, max: 1 });
  const schema = `diagnosis_${crypto.randomUUID().replaceAll("-", "")}`;
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 1 }, { schema }) });
  const sql = await pool.connect();
  const workspace = crypto.randomUUID();
  const channel = crypto.randomUUID();
  const memory = crypto.randomUUID();
  const task = crypto.randomUUID();
  const member = crypto.randomUUID();
  const source = crypto.randomUUID();
  const root = crypto.randomUUID();
  const future = crypto.randomUUID();
  const unrelated = crypto.randomUUID();
  try {
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`SET search_path TO "${schema}"`);
    await sql.query(`
      CREATE TABLE agents (id uuid PRIMARY KEY, name text, "workspaceId" uuid);
      CREATE TABLE conversations (id uuid PRIMARY KEY, "workspaceId" uuid, "channelName" text, "archivedAt" timestamptz, "hiddenFromWorkspaceAt" timestamptz);
      CREATE TABLE conversation_members (id uuid PRIMARY KEY, "conversationId" uuid, "workspaceId" uuid, "agentId" uuid, "leftAt" timestamptz);
      CREATE TABLE messages (id uuid PRIMARY KEY, "conversationId" uuid, "workspaceId" uuid, "senderMemberId" uuid, body text, sequence int, "createdAt" timestamptz DEFAULT now(), "threadRootId" uuid);
      CREATE TABLE message_mentions ("messageId" uuid, "memberId" uuid, "conversationId" uuid, "workspaceId" uuid, kind text, "actorId" uuid, handle text, PRIMARY KEY ("messageId", "memberId"));
    `);
    await sql.query("INSERT INTO agents VALUES ($1, $2, $5), ($3, $4, $5)", [
      memory,
      "memory",
      task,
      "task",
      workspace,
    ]);
    await sql.query(
      'INSERT INTO conversations (id, "workspaceId", "channelName") VALUES ($1,$2,$3)',
      [channel, workspace, "research"],
    );
    await sql.query(
      'INSERT INTO conversation_members (id,"conversationId","workspaceId","agentId") VALUES ($1,$2,$3,$4),($5,$2,$3,$6)',
      [member, channel, workspace, task, crypto.randomUUID(), memory],
    );
    for (const row of [
      [root, null, "Identify the person from the source documents.", 1, null],
      [unrelated, null, "UNRELATED_THREAD_CONTENT", 2, null],
      [
        source,
        member,
        "I tried several queries but cannot verify the director or the debut series.",
        3,
        root,
      ],
      [future, member, "FUTURE_INFORMATION_MUST_NOT_ENTER_DIAGNOSIS", 4, root],
    ])
      await sql.query(
        'INSERT INTO messages(id,"conversationId","workspaceId","senderMemberId",body,sequence,"threadRootId") VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [row[0], channel, workspace, ...row.slice(1)],
      );
    const input = { workspaceId: workspace, agentId: memory, messageId: source };
    const scope = await resolveMemoryDiagnosisScope(db, input);
    expect(scope.requestId).toBe(source);
    expect(scope.triggerKind).toBe("task_state");
    expect(scope.targetAgentId).toBe(task);
    expect(scope.conversationId).toBe(channel);
    expect(scope.messages.map((m) => m.sourceMessageIds)).toEqual([[root], [source]]);
    expect(scope.question).toContain("cannot verify the director");
    expect(JSON.stringify(scope)).not.toContain("FUTURE_INFORMATION");
    expect(JSON.stringify(scope)).not.toContain("UNRELATED_THREAD");
    expect((await resolveMemoryDiagnosisScope(db, input)).requestId).toBe(source);
    await expect(
      resolveMemoryDiagnosisScope(db, { ...input, workspaceId: crypto.randomUUID() }),
    ).rejects.toThrow("diagnosis_scope_denied");
    await expect(resolveMemoryDiagnosisScope(db, { ...input, agentId: task })).rejects.toThrow(
      "diagnosis_scope_denied",
    );
    await expect(resolveMemoryDiagnosisScope(db, { ...input, messageId: root })).rejects.toThrow(
      "diagnosis_scope_denied",
    );
    await sql.query('UPDATE conversation_members SET "leftAt"=now() WHERE "agentId"=$1', [memory]);
    await expect(resolveMemoryDiagnosisScope(db, input)).rejects.toThrow("diagnosis_scope_denied");
    await sql.query('UPDATE conversation_members SET "leftAt"=null');
    await sql.query('UPDATE conversations SET "archivedAt"=now()');
    await expect(resolveMemoryDiagnosisScope(db, input)).rejects.toThrow("diagnosis_scope_denied");
    await sql.query('UPDATE conversations SET "archivedAt"=null,"channelName"=null');
    await expect(resolveMemoryDiagnosisScope(db, input)).rejects.toThrow("diagnosis_scope_denied");
    await sql.query('UPDATE conversations SET "channelName"=$1,"hiddenFromWorkspaceAt"=now()', [
      "research",
    ]);
    await expect(resolveMemoryDiagnosisScope(db, input)).rejects.toThrow("diagnosis_scope_denied");
    await sql.query('UPDATE conversations SET "hiddenFromWorkspaceAt"=null');
    await sql.query("UPDATE messages SET body=$1 WHERE id=$2", [
      "@memory diagnose why the queries failed",
      source,
    ]);
    expect((await resolveMemoryDiagnosisScope(db, input)).triggerKind).toBe("explicit_request");
  } finally {
    await db.$disconnect();
    await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    sql.release();
    await pool.end();
  }
}, 15000);

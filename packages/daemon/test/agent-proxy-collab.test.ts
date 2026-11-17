import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { startAgentProxy } from "#src/agent-proxy";
import { AgentContextLedger } from "#src/persistence/agent-context-ledger";
import { AgentMessageDraftStore } from "#src/persistence/agent-message-draft-store";
import { AgentStateDb } from "#src/persistence/agent-state-db";

const proxies: Array<{ close(): void }> = [];
const upstreams: Array<{ stop(close?: boolean): void }> = [];
const directories: string[] = [];

afterEach(async () => {
  for (const proxy of proxies.splice(0)) proxy.close();
  for (const upstream of upstreams.splice(0)) upstream.stop(true);
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function tempStateDir(): string {
  const dir = join(tmpdir(), `coforge-proxy-collab-${crypto.randomUUID()}`);
  directories.push(dir);
  return dir;
}

describe("agent-proxy P1-6 features", () => {
  test("discards saved message drafts locally and enforces --expected-draft-key", async () => {
    const stateDirectory = tempStateDir();
    const stateDb = AgentStateDb.open(stateDirectory, "agent-a");
    const store = new AgentMessageDraftStore(stateDb);
    await store.save("#general", {
      content: "Held draft text",
      idempotencyKey: "draft-key-1",
    });
    stateDb.close();

    const proxy = startAgentProxy({
      stateDirectory,
      runtime: { agentMessage: async () => ({}) },
    });
    proxies.push(proxy);
    const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);

    // Mismatched expectedDraftKey refuses with SAVED_DRAFT_IDENTITY_CHANGED and preserves draft.
    const mismatch = await fetch(proxy.url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "req-1",
        operation: "send",
        target: "#general",
        discardDraft: true,
        expectedDraftKey: "wrong-key",
      }),
    });
    expect(mismatch.status).toBe(400);
    const mismatchBody = (await mismatch.json()) as {
      code?: string;
      proxy?: { failure_class?: string };
    };
    expect(mismatchBody.code).toBe("SAVED_DRAFT_IDENTITY_CHANGED");
    expect(mismatchBody.proxy?.failure_class).toBe("local_precondition");

    // Matching expectedDraftKey discards the draft.
    const ok = await fetch(proxy.url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "req-2",
        operation: "send",
        target: "#general",
        discardDraft: true,
        expectedDraftKey: "draft-key-1",
      }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      accepted: true,
      clearedDraft: true,
      discarded: true,
      discardedDraftKey: "draft-key-1",
      target: "#general",
    });

    // Discarding again when absent succeeds idempotently with discarded: false.
    const second = await fetch(proxy.url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "req-3",
        operation: "send",
        target: "#general",
        discardDraft: true,
      }),
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      accepted: true,
      discarded: false,
    });
  });

  test("forwards POST /api/agent/v1/threads/:thread/follow to cloud with Agent + Daemon credentials", async () => {
    const received: {
      method: string;
      path: string;
      auth: string | null;
      agentKey: string | null;
    }[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        received.push({
          method: req.method,
          path: url.pathname,
          auth: req.headers.get("authorization"),
          agentKey: req.headers.get("x-coforge-agent-api-key"),
        });
        return Response.json({
          idempotencyKey: "k1",
          target: "#general:12345678",
          followed: true,
        });
      },
    });
    upstreams.push(upstream);

    const agentKey = `sk_agent_${"b".repeat(43)}`;
    const proxy = startAgentProxy({
      cloudForward: {
        serverHttpUrl: `http://127.0.0.1:${upstream.port}`,
        daemonApiKey: () => Promise.resolve("sk_computer_test_key"),
      },
      runtime: { agentMessage: async () => ({}) },
    });
    proxies.push(proxy);
    const token = proxy.issue("agent-a", agentKey);
    const baseUrl = new URL(proxy.url).origin;

    const res = await fetch(
      `${baseUrl}${agentApiRoutes.proxy.threadFollow.path("#general:12345678")}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: "k1" }),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      idempotencyKey: "k1",
      target: "#general:12345678",
      followed: true,
    });
    expect(received).toEqual([
      {
        method: "POST",
        path: "/api/agent/v1/threads/%23general%3A12345678/follow",
        auth: "Bearer sk_computer_test_key",
        agentKey: `Bearer ${agentKey}`,
      },
    ]);
  });

  test("tracks progressive command guidance once per contextGeneration when reportsCompaction is true, re-delivers after compaction, pre-satisfies on --help, and returns inline hint when false", async () => {
    const stateDirectory = tempStateDir();
    const stateDb = AgentStateDb.open(stateDirectory, "agent-compacting");
    const ledger = new AgentContextLedger(stateDb.database);
    ledger.advance(); // generation 1 => compaction-reporting runtime
    stateDb.close();

    const proxy = startAgentProxy({
      stateDirectory,
      reportsCompaction: (agentId) => agentId === "agent-compacting",
      runtime: { agentMessage: async () => ({}) },
    });
    proxies.push(proxy);
    const compactToken = proxy.issue("agent-compacting", `sk_agent_${"c".repeat(43)}`);
    const nonCompactToken = proxy.issue("agent-plain", `sk_agent_${"d".repeat(43)}`);
    const guidanceUrl = `${new URL(proxy.url).origin}${agentApiRoutes.proxy.guidance.path}`;

    const ask = async (token: string, body: Record<string, unknown>) => {
      const res = await fetch(guidanceUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { ok: true; guidance: string | null; mode?: string };
    };

    // First check in generation 1 delivers guidance once.
    const first = await ask(compactToken, { operation: "check", command: "task" });
    expect(first.guidance).toBeTruthy();
    expect(first.mode).toBe("once_per_context");

    // Second check in same generation elides it.
    const second = await ask(compactToken, { operation: "check", command: "task" });
    expect(second.guidance).toBeNull();

    // Advancing contextGeneration (compaction) re-enables guidance; --help pre-satisfies it.
    const reopened = AgentStateDb.open(stateDirectory, "agent-compacting");
    new AgentContextLedger(reopened.database).advance();
    reopened.close();

    await ask(compactToken, { operation: "satisfy", command: "action" });
    const afterHelp = await ask(compactToken, { operation: "check", command: "action" });
    expect(afterHelp.guidance).toBeNull();

    const afterCompaction = await ask(compactToken, { operation: "check", command: "task" });
    expect(afterCompaction.guidance).toBeTruthy();

    // Non-compacting runtime always receives inline hint without SQLite elision.
    const inline1 = await ask(nonCompactToken, { operation: "check", command: "task" });
    const inline2 = await ask(nonCompactToken, { operation: "check", command: "task" });
    expect(inline1.mode).toBe("inline");
    expect(inline1.guidance).toBeTruthy();
    expect(inline2.guidance).toBe(inline1.guidance);
  });
});

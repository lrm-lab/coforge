import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { RUNTIME_PROVIDER, type RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { startAgentProxy } from "#src/agent-proxy";
import { daemonAgentProxyRuntime } from "#src/agent-proxy-daemon-runtime";
import { AgentPreflightError } from "#src/daemon-runtime/agent-preflight-error";
import type { DaemonRuntime } from "#src/daemon-runtime/runtime";
import { AgentContextLedger } from "#src/persistence/agent-context-ledger";
import { AgentAppInboxPersistence } from "#src/persistence/agent-app-inbox-store";
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

const postJson = (url: string, token: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

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

    const mismatch = await postJson(proxy.url, token, {
      idempotencyKey: "req-1",
      operation: "send",
      target: "#general",
      discardDraft: true,
      expectedDraftKey: "wrong-key",
    });
    expect(mismatch.status).toBe(400);
    const mismatchBody = (await mismatch.json()) as {
      code?: string;
      proxy?: { failure_class?: string };
    };
    expect(mismatchBody.code).toBe("SAVED_DRAFT_IDENTITY_CHANGED");
    expect(mismatchBody.proxy?.failure_class).toBe("local_precondition");

    const ok = await postJson(proxy.url, token, {
      idempotencyKey: "req-2",
      operation: "send",
      target: "#general",
      discardDraft: true,
      expectedDraftKey: "draft-key-1",
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      accepted: true,
      clearedDraft: true,
      discarded: true,
      discardedDraftKey: "draft-key-1",
      target: "#general",
    });

    const second = await postJson(proxy.url, token, {
      idempotencyKey: "req-3",
      operation: "send",
      target: "#general",
      discardDraft: true,
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

  test("forwards P1-7 inbox read, inbox dismiss, and action withdraw routes to cloud with Agent + Daemon credentials", async () => {
    const received: Array<{
      method: string;
      path: string;
      search: string;
      body: unknown;
      auth: string | null;
      agentKey: string | null;
    }> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = req.method === "GET" ? null : await req.json();
        received.push({
          method: req.method,
          path: url.pathname,
          search: url.search,
          body,
          auth: req.headers.get("authorization"),
          agentKey: req.headers.get("x-coforge-agent-api-key"),
        });
        if (url.pathname === "/api/agent/v1/inbox/read") {
          return Response.json({
            ok: true,
            kind: "conversation",
            target: "#general",
            items: [],
            hasMore: false,
            nextCursor: null,
          });
        }
        if (url.pathname === "/api/agent/v1/inbox/dismiss") {
          return Response.json({
            ok: true,
            mode: "target",
            dismissedConversations: 1,
            dismissedThreads: 0,
            dismissedAppTargets: 0,
            dismissedReminders: 0,
            targets: ["#general"],
          });
        }
        return Response.json({
          ok: true,
          messageId: "0196ed00-0000-7000-8000-000000000088",
          state: "cancelled",
        });
      },
    });
    upstreams.push(upstream);

    const agentKey = `sk_agent_${"e".repeat(43)}`;
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

    const readRes = await fetch(
      `${baseUrl}${agentApiRoutes.proxy.inboxRead.path}?target=%23general&limit=10`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(readRes.status).toBe(200);

    const dismissRes = await fetch(`${baseUrl}${agentApiRoutes.proxy.inboxDismiss.path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ target: "#general" }),
    });
    expect(dismissRes.status).toBe(200);

    const withdrawRes = await fetch(`${baseUrl}${agentApiRoutes.proxy.actionWithdraw.path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ messageId: "0196ed00-0000-7000-8000-000000000088" }),
    });
    expect(withdrawRes.status).toBe(200);

    expect(received.map((r) => `${r.method} ${r.path}${r.search}`)).toEqual([
      "GET /api/agent/v1/inbox/read?target=%23general&limit=10",
      "POST /api/agent/v1/inbox/dismiss",
      "POST /api/agent/v1/actions/withdraw",
    ]);
    for (const call of received) {
      expect(call.auth).toBe("Bearer sk_computer_test_key");
      expect(call.agentKey).toBe(`Bearer ${agentKey}`);
    }
  });

  test("daemonAgentProxyRuntime enforces authorizedAgent, canonicalizes short thread drafts, settles attention on inbox read/dismiss, and never elides guidance after switching to a non-compacting provider", async () => {
    const stateDirectory = tempStateDir();
    const fullThread = "#general:0196ed00-0000-7000-8000-00000000abcd";
    const stateDb = AgentStateDb.open(stateDirectory, "agent-rt");
    // Seed a draft under the full thread UUID and a non-zero contextGeneration from a prior Claude session.
    await new AgentMessageDraftStore(stateDb).save(fullThread, {
      content: "Thread reply draft",
      idempotencyKey: "thread-draft-key",
    });
    new AgentContextLedger(stateDb.database).advance();
    stateDb.close();
    const dueReminderId = "0196ed00-0000-7000-8000-000000000011";
    await new AgentAppInboxPersistence(stateDirectory, "ws-rt", "agent-rt").write([
      {
        id: `reminder:due:${dueReminderId}:2`,
        appId: "system.reminder",
        notificationClass: "due",
        sourceRef: { kind: "reminder", id: dueReminderId, revision: "2" },
        title: "Due check",
        summary: "Due check summary",
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    ]);

    // First verify that with reportsCompaction omitted, stale generation > 0 does NOT elide guidance!
    const defaultProxy = startAgentProxy({
      stateDirectory,
      runtime: { agentMessage: async () => ({}) },
    });
    proxies.push(defaultProxy);
    const defaultTok = defaultProxy.issue("agent-rt", `sk_agent_${"f".repeat(43)}`);
    const gUrl = `${new URL(defaultProxy.url).origin}${agentApiRoutes.proxy.guidance.path}`;
    const g1 = await fetch(gUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${defaultTok}`, "content-type": "application/json" },
      body: JSON.stringify({ operation: "check", command: "task" }),
    });
    expect(await g1.json()).toMatchObject({ mode: "inline" });
    const g2 = await fetch(gUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${defaultTok}`, "content-type": "application/json" },
      body: JSON.stringify({ operation: "check", command: "task" }),
    });
    expect(((await g2.json()) as { guidance: string | null }).guidance).toBeTruthy();

    // Now test daemonAgentProxyRuntime integration:
    let daemonRunning = true;
    let currentProvider: RuntimeProvider = RUNTIME_PROVIDER.CURSOR;
    const messageCalls: unknown[] = [];
    const reminderCalls: unknown[] = [];
    const fakeDaemon = {
      stateDirectory,
      issueAgentContext: (id: string) => `ctx-${id}`,
      authorizedAgent(ctx: string, key: string | undefined) {
        if (!daemonRunning) throw new AgentPreflightError("not running", "DAEMON_NOT_RUNNING");
        if (!ctx || !key) throw new AgentPreflightError("missing", "AGENT_API_KEY_MISSING");
        return "agent-rt";
      },
      runtime: () => ({ config: { provider: currentProvider } }),
      restartConfig: () => undefined,
      async reminder(_ctx: string, req: Record<string, unknown>) {
        reminderCalls.push(req);
        return { accepted: true };
      },
      async agentMessage(_ctx: string, req: Record<string, unknown>) {
        messageCalls.push(req);
        if (req.around === "0196ed00") {
          return {
            accepted: true,
            messages: [
              { id: "0196ed00-0000-7000-8000-00000000abcd", target: "#general", sequence: 3 },
            ],
          };
        }
        return {
          idempotencyKey: String(req.idempotencyKey ?? "k"),
          accepted: true,
          attentionCount: 0,
          messageId: "",
          messages: [
            {
              id: "0196ed00-0000-7000-8000-000000000077",
              sequence: 9,
              senderHandle: "alice",
              senderKind: "human",
              target: String(req.target ?? "#general"),
              createdAt: "2026-11-18T00:00:00.000Z",
              body: "Settled via runtime",
            },
          ],
          summaries: [],
          moreUnread: false,
          hasNewer: false,
          readPositionAfter: 9,
        };
      },
    } as unknown as DaemonRuntime;

    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        return Response.json({
          ok: true,
          mode: "target",
          dismissedConversations: 1,
          dismissedThreads: 0,
          dismissedAppTargets: 0,
          dismissedReminders: 0,
          targets: ["#general", "reminder:0196ed00-0000-7000-8000-000000000011"],
        });
      },
    });
    upstreams.push(upstream);

    const rtProxy = startAgentProxy({
      cloudForward: {
        serverHttpUrl: `http://127.0.0.1:${upstream.port}`,
        daemonApiKey: () => Promise.resolve("sk_computer_rt"),
      },
      runtime: daemonAgentProxyRuntime(() => fakeDaemon),
    });
    proxies.push(rtProxy);
    const rtTok = rtProxy.issue("agent-rt", `sk_agent_${"g".repeat(43)}`);
    const rtBase = new URL(rtProxy.url).origin;

    const discardShort = await postJson(rtProxy.url, rtTok, {
      idempotencyKey: "d-short",
      operation: "send",
      target: "#general:0196ed00",
      discardDraft: true,
      expectedDraftKey: "thread-draft-key",
    });
    expect(discardShort.status).toBe(200);
    expect(await discardShort.json()).toMatchObject({
      discarded: true,
      discardedDraftKey: "thread-draft-key",
      target: fullThread,
    });

    messageCalls.length = 0;
    const inboxReadRes = await fetch(
      `${rtBase}${agentApiRoutes.proxy.inboxRead.path}?target=%23general&limit=5`,
      { headers: { authorization: `Bearer ${rtTok}` } },
    );
    expect(inboxReadRes.status).toBe(200);
    expect(await inboxReadRes.json()).toMatchObject({
      ok: true,
      kind: "conversation",
      target: "#general",
      readPositionAfter: 9,
    });
    expect(messageCalls[0]).toMatchObject({
      operation: "read",
      target: "#general",
      unread: true,
      limit: 5,
    });

    messageCalls.length = 0;
    reminderCalls.length = 0;
    const inboxDismissRes = await postJson(
      `${rtBase}${agentApiRoutes.proxy.inboxDismiss.path}`,
      rtTok,
      { target: "#general" },
    );
    expect(inboxDismissRes.status).toBe(200);
    expect(messageCalls).toHaveLength(1);
    expect(messageCalls[0]).toMatchObject({
      operation: "read",
      target: "#general",
      unread: true,
      limit: 1,
    });
    expect(reminderCalls).toHaveLength(1);
    expect(reminderCalls[0]).toMatchObject({
      operation: "dismiss",
      reminderId: dueReminderId,
      revision: 2,
    });

    const codexG = await postJson(`${rtBase}${agentApiRoutes.proxy.guidance.path}`, rtTok, {
      operation: "check",
      command: "action",
    });
    expect(await codexG.json()).toMatchObject({ mode: "inline" });

    currentProvider = RUNTIME_PROVIDER.CLAUDE_CODE;
    const claudeG1 = await postJson(`${rtBase}${agentApiRoutes.proxy.guidance.path}`, rtTok, {
      operation: "check",
      command: "action",
    });
    expect(await claudeG1.json()).toMatchObject({ mode: "once_per_context" });

    daemonRunning = false;
    const stoppedRes = await postJson(
      `${rtBase}${agentApiRoutes.proxy.actionWithdraw.path}`,
      rtTok,
      { messageId: "0196ed00-0000-7000-8000-000000000088" },
    );
    expect(stoppedRes.status).toBe(400);
    expect(((await stoppedRes.json()) as { code?: string }).code).toBe("DAEMON_NOT_RUNNING");
  });
});

import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_COMMAND_GUIDANCE, agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { startAgentProxy } from "#src/agent-proxy";
import {
  AgentContextLedger,
  evaluateAgentCommandGuidance,
} from "#src/persistence/agent-context-ledger";
import { AgentMessageDraftStore } from "#src/persistence/agent-message-draft-store";
import { AgentStateDb } from "#src/persistence/agent-state-db";

const proxies: Array<{ close(): void }> = [];
const upstreams: Array<{ stop(close?: boolean): void }> = [];
const dbs: AgentStateDb[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const proxy of proxies.splice(0)) proxy.close();
  for (const upstream of upstreams.splice(0)) upstream.stop(true);
  for (const db of dbs.splice(0)) db.close();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function tempStateDir(): string {
  const dir = join(tmpdir(), `coforge-proxy-collab-reuse-${crypto.randomUUID()}`);
  directories.push(dir);
  return dir;
}

test("evaluateAgentCommandGuidance reuses a borrowed AgentStateDb without closing it", () => {
  const stateDirectory = tempStateDir();
  const stateDb = AgentStateDb.open(stateDirectory, "agent-a");
  dbs.push(stateDb);
  const command = Object.keys(AGENT_COMMAND_GUIDANCE)[0]!;
  const expectedGuidance = AGENT_COMMAND_GUIDANCE[command]!;

  const first = evaluateAgentCommandGuidance({
    stateDirectory,
    stateDb,
    agentId: "agent-a",
    operation: "check",
    command,
    reportsCompaction: () => true,
  });
  expect(first).toEqual({
    ok: true,
    guidance: expectedGuidance,
    mode: "once_per_context",
  });

  const second = evaluateAgentCommandGuidance({
    stateDirectory,
    stateDb,
    agentId: "agent-a",
    operation: "check",
    command,
    reportsCompaction: () => true,
  });
  expect(second).toEqual({ ok: true, guidance: null, mode: "once_per_context" });

  expect(new AgentContextLedger(stateDb.database).generation()).toBe(0);
});

test("collab proxy routes reuse runtime.collab.stateDb for guidance and discardDraft and follow dynamic serverHttpUrl", async () => {
  const stateDirectory = tempStateDir();
  const sharedDb = AgentStateDb.open(stateDirectory, "agent-a");
  dbs.push(sharedDb);
  const draftStore = new AgentMessageDraftStore(sharedDb);
  await draftStore.save("#general", {
    content: "Held draft",
    idempotencyKey: "draft-reuse-1",
  });

  let stateDbCalls = 0;
  const hitPorts: number[] = [];
  const makeUpstream = () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        hitPorts.push(server.port!);
        return Response.json({ idempotencyKey: "k1", target: "#general:12345678", followed: true });
      },
    });
    upstreams.push(server);
    return server;
  };
  const upstreamA = makeUpstream();
  const upstreamB = makeUpstream();
  let currentServerUrl = `http://127.0.0.1:${upstreamA.port}`;

  const proxy = startAgentProxy({
    stateDirectory,
    cloudForward: {
      serverHttpUrl: () => currentServerUrl,
      daemonApiKey: async () => "sk_computer_reuse",
    },
    runtime: {
      agentMessage: async () => ({}),
      collab: {
        authorize: () => "agent-a",
        stateDirectory: () => stateDirectory,
        reportsCompaction: () => true,
        stateDb: (agentId) => {
          expect(agentId).toBe("agent-a");
          stateDbCalls += 1;
          return sharedDb;
        },
        canonicalizeTarget: async (_ctx, target) => target,
        readMessagesForInbox: async () => ({
          ok: true,
          kind: "conversation",
          target: "#general",
          items: [],
          hasMore: false,
          nextCursor: null,
        }),
        settleDismissedTargets: async () => undefined,
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
  const baseUrl = new URL(proxy.url).origin;
  const command = Object.keys(AGENT_COMMAND_GUIDANCE)[0]!;

  const g1 = await fetch(`${baseUrl}${agentApiRoutes.proxy.guidance.path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ operation: "check", command }),
  });
  expect(g1.status).toBe(200);
  expect((await g1.json()) as { guidance: string | null }).toMatchObject({
    guidance: AGENT_COMMAND_GUIDANCE[command],
  });

  const discard = await fetch(proxy.url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: "req-discard",
      operation: "send",
      target: "#general",
      discardDraft: true,
      expectedDraftKey: "draft-reuse-1",
    }),
  });
  expect(discard.status).toBe(200);
  expect(await discard.json()).toMatchObject({ discarded: true, clearedDraft: true });
  expect(stateDbCalls).toBe(2);
  expect((await draftStore.lookup("#general")).status).toBe("missing");

  const followA = await fetch(
    `${baseUrl}${agentApiRoutes.proxy.threadFollow.path("#general:12345678")}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "k1" }),
    },
  );
  expect(followA.status).toBe(200);

  currentServerUrl = `http://127.0.0.1:${upstreamB.port}`;
  const followB = await fetch(
    `${baseUrl}${agentApiRoutes.proxy.threadFollow.path("#general:12345678")}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "k2" }),
    },
  );
  expect(followB.status).toBe(200);
  expect(hitPorts).toEqual([upstreamA.port!, upstreamB.port!]);
});

test("discardDraft re-authorizes after async canonicalizeTarget and borrowStateDb returns undefined once closed", async () => {
  const { AgentConsumedSeqStore } = await import("#src/persistence/agent-consumed-seq-store");
  const stateDirectory = tempStateDir();
  const consumedStore = new AgentConsumedSeqStore(stateDirectory);
  const opened = consumedStore.borrowStateDb("agent-a");
  expect(opened).toBeDefined();
  consumedStore.close();
  expect(consumedStore.borrowStateDb("agent-a")).toBeUndefined();

  let authorized = true;
  let stateDbCalls = 0;
  let markEntered!: () => void;
  const enteredCanonicalize = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  let releaseCanonicalize!: (target: string) => void;
  const proxy = startAgentProxy({
    stateDirectory,
    runtime: {
      agentMessage: async () => ({}),
      collab: {
        authorize: () => {
          if (!authorized) throw new Error("unauthorized");
          return "agent-a";
        },
        stateDirectory: () => stateDirectory,
        reportsCompaction: () => true,
        stateDb: () => {
          stateDbCalls += 1;
          return undefined;
        },
        canonicalizeTarget: () =>
          new Promise((resolve) => {
            markEntered();
            releaseCanonicalize = resolve;
          }),
        readMessagesForInbox: async () => ({
          ok: true,
          kind: "conversation",
          target: "#general",
          items: [],
          hasMore: false,
          nextCursor: null,
        }),
        settleDismissedTargets: async () => undefined,
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);

  const pending = fetch(proxy.url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: "req-race",
      operation: "send",
      target: "#general:12345678",
      discardDraft: true,
    }),
  });
  await enteredCanonicalize;
  authorized = false;
  releaseCanonicalize("#general:12345678");
  const res = await pending;
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(stateDbCalls).toBe(0);
});

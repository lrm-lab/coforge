import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeAgentMemory } from "#src/daemon-runtime/agent-memory-composition";
import { AgentDeliveryGate } from "#src/daemon-runtime/agent-delivery-gate";
import { AgentLifecycle } from "#src/daemon-runtime/agent-lifecycle";
import { AgentStateDb } from "#src/persistence/agent-state-db";
import { MemoryReviewLedger } from "#src/persistence/memory-review-ledger";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { AgentContexts } from "#src/daemon-runtime/agent-contexts";
import type { AgentSession } from "@lrm/coforge-anvil";
import {
  AGENT_MESSAGE_METHOD,
  WORKSPACE_PROTOCOL_MAJOR,
  type AgentMessageDelivery,
} from "@lrm/coforge-sdk/internal";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

test("the composed memory API honors delivery holds before notifying the original session", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-review-runtime-"));
  await mkdir(join(root, "workspace/agents/agent"), { recursive: true });
  const db = AgentStateDb.open(root, "agent");
  const ledger = new MemoryReviewLedger(db.database);
  const gate = new AgentDeliveryGate();
  const lifecycle = new AgentLifecycle();
  const prompts: string[] = [];
  const memory = composeAgentMemory(
    {
      contexts: { memoryReviewLedger: () => ledger },
      runtimeRelease: { coldIdleAgent: () => ({ busyReason: undefined }) },
      connection: { workspaceRoot: root, workspaceId: "workspace" },
      agentProcessManager: {
        session: () => ({
          hasLiveTurn: false,
          notify: async (text: string) => {
            prompts.push(text);
          },
        }),
      },
      authorizeMemory: () => "agent",
      systemCleaner: { onMemoryWrite() {} },
      isStopping: () => false,
      deliveryGate: gate,
      lifecycle,
    } as unknown as Parameters<typeof composeAgentMemory>[0],
    () => false,
  );
  cleanup.push(async () => {
    memory.review.clear();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  memory.review.noteHuman("agent", Date.now() - 1);
  await memory.local.execute(
    "context",
    {
      operation: "save",
      key: "lesson",
      revision: "new",
      title: "A lesson",
      content: "Keep evidence",
      source: "a public source",
      kind: "fact",
      applicability: "",
    },
    "key",
  );
  for (const reason of [
    "runtime_error_backoff",
    "credential_invalid",
    "fingerprint_fence",
  ] as const) {
    gate.hold("agent", reason);
    await memory.review.inspect("agent");
    expect(prompts).toHaveLength(0);
    gate.release("agent");
  }
  await memory.review.inspect("agent");
  expect(prompts).toHaveLength(1);
  expect(ledger.pending()[0]?.key).toBe("lesson");
  lifecycle.processClosed("agent");
});

async function attentionSubject() {
  const root = await mkdtemp(join(tmpdir(), "memory-review-attention-"));
  const db = AgentStateDb.open(root, "agent");
  const contexts = new AgentContexts(() => db);
  const session = { notify: async () => {} } as unknown as AgentSession;
  const attention = new AgentMessageAttentionIndex(
    "workspace",
    { session: () => session },
    async () => {},
    () => {},
    {
      shouldHold: () => false,
      enqueue() {},
      busy() {},
      noticeAccepted: (id, messages) => contexts.noteMemoryActivity(id, messages),
    },
  );
  cleanup.push(async () => {
    attention.clearAgent("agent");
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  attention.beginNoticeContext("agent");
  const message = {
    protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
    method: AGENT_MESSAGE_METHOD,
    workspaceId: "workspace",
    agentId: "agent",
    latestSenderKind: "human",
    latestSenderHandle: "person",
    latestSenderDescription: "",
    createdAtMs: Date.now(),
    target: "@person",
    messageId: "message",
    deliveryId: "delivery",
    requestId: "request",
    conversationId: "conversation",
    sequence: 1,
    body: "Please remember this",
  } satisfies AgentMessageDelivery;
  return { attention, contexts, message };
}

test("a human message accepted after a wake records activity at the live-session seam", async () => {
  const h = await attentionSubject();
  expect(h.contexts.memoryReviewLedger("agent").state().humanAt).toBe(0);
  await h.attention.receive(h.message);
  expect(h.contexts.memoryReviewLedger("agent").state().humanAt).toBe(h.message.createdAtMs);
});

test("recovered human messages also qualify, while cancelled generations cannot write state", async () => {
  const h = await attentionSubject();
  const stale = h.attention.captureNoticeAcceptance("agent");
  h.attention.clearAgent("agent");
  expect(stale([h.message])).toBe(false);
  expect(h.contexts.memoryReviewLedger("agent").state().humanAt).toBe(0);
  h.attention.beginNoticeContext("agent");
  await h.attention.recover("agent", [h.message], { "@person": 1 });
  expect(h.contexts.memoryReviewLedger("agent").state().humanAt).toBe(h.message.createdAtMs);
});

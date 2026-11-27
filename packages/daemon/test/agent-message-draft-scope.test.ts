import { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";
import { AgentMessageDraftStore } from "#src/persistence/agent-message-draft-store";
import { AgentStateDb } from "#src/persistence/agent-state-db";
import { afterAll, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessageRequest, LocalAgentMessageRequest } from "@lrm/coforge-sdk/internal";
import type {
  AgentConsumptionEvidenceRequest,
  AgentMessageTransportResponse,
} from "#src/connection/agent-http-clients";
import { createMessageHarness } from "./fixtures/message-harness";
import { readScope } from "./fixtures/message-record";

const workspaceRoot = await mkdtemp(join(realpathSync(tmpdir()), "coforge-draft-scope-"));
afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
const openHarness = createMessageHarness({
  connection: { computerId: "computer-a", workspaceId: "workspace-a", workspaceRoot },
  config: { provider: "pi", model: "default", modelProvider: "anthropic", reasoning: "balanced" },
});
const target = "@ada";
const original = "conversation-a";
const replacement = "conversation-b";

test.each(["send-draft", "continue", "old-draft"] as const)(
  "%s restores only the original draft scope after a restart and same-name recreation",
  async (operation) => {
    const stateDirectory = join(workspaceRoot, crypto.randomUUID());
    const sends: (AgentMessageRequest & AgentConsumptionEvidenceRequest)[] = [];
    const respond = async (
      request: AgentMessageRequest,
    ): Promise<AgentMessageTransportResponse> => {
      const response = { idempotencyKey: request.idempotencyKey, attentionCount: 0, messages: [] };
      if (request.operation === "read")
        return {
          ...response,
          accepted: true,
          consumptionScope: {
            ...readScope(request.agentId, target),
            conversationId: request.idempotencyKey === "read-original" ? original : replacement,
          },
          modelSeenUpToSeq: request.idempotencyKey === "read-original" ? 31 : 70,
        };
      sends.push(request);
      return sends.length === 1
        ? {
            ...response,
            accepted: false,
            state: "held",
            seenUpToSeq: 35,
            writeConsumptionScope:
              operation === "old-draft" ? undefined : { conversationId: original },
          }
        : { ...response, accepted: true, state: "sent", messageId: "sent" };
    };
    const open = () =>
      openHarness(respond, undefined, undefined, undefined, undefined, stateDirectory);
    const run = (
      harness: Awaited<ReturnType<typeof open>>,
      fields: Omit<LocalAgentMessageRequest, "context" | "idempotencyKey">,
    ) =>
      harness.runtime.agentMessage(
        harness.context,
        { context: harness.context, idempotencyKey: crypto.randomUUID(), ...fields },
        harness.apiKey,
      );

    const before = await open();
    let continuationId: string | undefined;
    try {
      if (operation !== "old-draft") {
        await before.runtime.agentMessage(
          before.context,
          { idempotencyKey: "read-original", context: before.context, operation: "read", target },
          before.apiKey,
        );
      }
      const held = await run(before, { operation: "send", target, content: "held reply" });
      continuationId = held.continuation?.id;
      await before.runtime.handleAgentMessage({
        protocolMajor: 1,
        requestId: "replacement-delivery",
        messageId: "replacement-message",
        deliveryId: "replacement-delivery",
        sequence: 70,
        workspaceId: "workspace-a",
        conversationId: replacement,
        agentId: "agent-a",
        method: "agent:v1:message:deliver",
        target,
        body: "new conversation",
      });
      await run(before, { operation: "read", target });
    } finally {
      await before.runtime.stop();
    }

    const verify = new AgentConsumedSeqStore(stateDirectory);
    const saved = verify.read("agent-a");
    const draft = await new AgentMessageDraftStore(verify.stateDb("agent-a")).lookup(target);
    verify.close();
    expect(saved.scopedTargets).toContainEqual({
      target,
      entry: expect.objectContaining({ conversationId: replacement, seq: 70 }),
    });
    if (operation !== "old-draft") {
      expect(saved.scopedTargets).toContainEqual({
        target,
        entry: expect.objectContaining({ conversationId: original, seq: 31 }),
      });
      expect(draft).toMatchObject({
        status: "found",
        draft: { consumptionScope: { conversationId: original } },
      });
    }
    const after = await open();
    try {
      if (operation === "continue") {
        expect(continuationId).toBeDefined();
        await run(after, {
          operation: "continue",
          continuationId,
          continuationChoice: "b",
          content: "updated reply",
        });
      } else {
        await run(after, { operation: "send", target, sendDraft: true });
      }
      expect(sends).toHaveLength(2);
      expect(sends[1]?.idempotencyKey).toBe(sends[0]?.idempotencyKey);
      expect(sends[1]?.seenUpToSeq).toBe(operation === "old-draft" ? undefined : 31);
      expect(sends[1]?.consumptionEvidence).toEqual(
        operation === "old-draft"
          ? undefined
          : [{ target: { conversationId: original }, entry: { seq: 31 } }],
      );
    } finally {
      await after.runtime.stop();
    }
  },
);

test("older draft writes are readable and clear identity when they replace the draft", async () => {
  const stateDirectory = join(workspaceRoot, crypto.randomUUID());
  const agentId = "agent-a";
  const oldWrite = (db: AgentStateDb, content: string) => {
    db.database
      .query(
        `INSERT OR REPLACE INTO drafts (target, content, idempotency_key, saved_at, seen_up_to_seq)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(target, content, "draft-key", 1, 31);
  };
  const initial = AgentStateDb.open(stateDirectory, agentId);
  try {
    initial.database.exec("ALTER TABLE drafts DROP COLUMN consumption_scope");
    oldWrite(initial, "older draft");
  } finally {
    initial.close();
  }

  const upgraded = AgentStateDb.open(stateDirectory, agentId);
  try {
    const drafts = new AgentMessageDraftStore(upgraded, () => 1);
    const old = await drafts.lookup(target);
    expect(old).toMatchObject({
      status: "found",
      draft: { content: "older draft", idempotencyKey: "draft-key", seenUpToSeq: 31 },
    });
    if (old.status !== "found") throw new Error("missing older draft");
    expect(old.draft.consumptionScope).toBeUndefined();

    const consumptionScope = { conversationId: original };
    await drafts.save(target, { ...old.draft, consumptionScope });
    expect(await drafts.lookup(target)).toMatchObject({ draft: { consumptionScope } });
    oldWrite(upgraded, "replaced on old daemon");
  } finally {
    upgraded.close();
  }

  const reopened = AgentStateDb.open(stateDirectory, agentId);
  try {
    const stored = await new AgentMessageDraftStore(reopened, () => 1).lookup(target);
    expect(stored).toMatchObject({ status: "found", draft: { content: "replaced on old daemon" } });
    if (stored.status !== "found") throw new Error("missing replacement draft");
    expect(stored.draft.consumptionScope).toBeUndefined();
  } finally {
    reopened.close();
  }
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { connectLocal } from "@lrm/coforge/local-client";
import { startAgentProxy } from "#src/agent-proxy";
import type { AgentMessageTransportResponse } from "#src/connection/agent-message-adapters";
import { AgentInboxStateMachine } from "#src/daemon-runtime/agent-inbox-state-machine";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { AgentMessageOperations } from "#src/daemon-runtime/agent-message-operations";
import { AgentStateDb } from "#src/persistence/agent-state-db";
import { AgentContinuationStore } from "#src/persistence/agent-continuation-store";
import { AgentMessageDraftStore } from "#src/persistence/agent-message-draft-store";

const roots: string[] = [];
const proxies: Array<ReturnType<typeof startAgentProxy>> = [];

afterEach(async () => {
  for (const proxy of proxies.splice(0)) proxy.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type SeenSend = {
  idempotencyKey: string;
  operation: string;
  target: string;
  content?: string;
  sendDraft?: boolean;
  continueAnyway?: boolean;
  expectedDraftKey?: string;
};

const transportHeld = (over: Partial<AgentMessageTransportResponse> = {}) => ({
  idempotencyKey: "",
  accepted: false,
  state: "held" as const,
  attentionCount: 0,
  messages: [],
  ...over,
});

const transportSent = (over: Partial<AgentMessageTransportResponse> = {}) => ({
  idempotencyKey: "",
  accepted: true,
  state: "sent" as const,
  attentionCount: 0,
  messages: [],
  messageId: "msg-1",
  ...over,
});

/** A full local stack — CLI client through the real proxy into the operations — whose transport
 * returns the scripted responses in order, accepting once the script runs out. */
async function fixture(script: AgentMessageTransportResponse[]) {
  const sent: SeenSend[] = [];
  const scripted = [...script];
  const root = await mkdtemp(join(tmpdir(), "coforge-continuation-"));
  roots.push(root);
  const db = AgentStateDb.open(root, "agent");
  const inbox = new AgentInboxStateMachine(
    new AgentMessageDraftStore(db),
    new AgentContinuationStore(db),
  );
  const attention = new AgentMessageAttentionIndex(
    "workspace",
    { session: () => undefined },
    async () => {},
  );
  const operations = new AgentMessageOperations({
    connection: { workspaceId: "workspace", computerId: "computer" },
    attention,
    inbox: () => inbox,
    transport: {
      agentMessage: async (request) => {
        sent.push(request as unknown as SeenSend);
        return scripted.shift() ?? transportSent();
      },
    },
    reportFreshnessHold: () => {},
  });
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: (_context, request, key) =>
        operations.handle("agent", request, request.target, key),
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent", `sk_agent_${"a".repeat(43)}`);
  const client = connectLocal("", token, proxy.url, "");
  return { sent, client };
}

const continuationOf = (response: unknown) =>
  (response as { continuation?: { id: string; choices: string[]; target: string } }).continuation;

test("a server-held send reports a continuation with the offered choices", async () => {
  const { sent, client } = await fixture([transportHeld()]);
  const held = (await client.send("#general", "reply", {})) as Record<string, unknown>;
  expect(sent).toHaveLength(1);
  expect(held.state).toBe("held");
  expect(continuationOf(held)).toMatchObject({
    target: "#general",
    choices: ["a", "b", "c"],
  });
  expect(continuationOf(held)?.id).toBeTruthy();
});

test("a re-held draft offers choice `d` once the server suggests anyway", async () => {
  const { client } = await fixture([
    transportHeld({ continueAnywaySuggested: true }),
    transportHeld({ continueAnywaySuggested: true }),
  ]);
  const held = (await client.send("#general", "reply", {})) as Record<string, unknown>;
  expect(continuationOf(held)?.choices).toEqual(["a", "b", "c", "d"]);
});

test("choice `a` resends the held draft under its idempotency key", async () => {
  const { sent, client } = await fixture([transportHeld(), transportSent()]);
  const held = (await client.send("#general", "reply", {})) as Record<string, unknown>;
  const answer = (await client.continue(continuationOf(held)!.id, "a")) as Record<string, unknown>;
  expect(answer).toMatchObject({ accepted: true, continuationTarget: "#general" });
  expect(sent).toHaveLength(2);
  expect(sent[1]).toMatchObject({
    operation: "send",
    target: "#general",
    sendDraft: true,
    idempotencyKey: sent[0]!.idempotencyKey,
  });
});

test("choice `b` sends the replacement body under the held draft's key", async () => {
  const { sent, client } = await fixture([transportHeld(), transportSent()]);
  const held = (await client.send("#general", "reply", {})) as Record<string, unknown>;
  const answer = (await client.continue(
    continuationOf(held)!.id,
    "b",
    "replacement body",
  )) as Record<string, unknown>;
  expect(answer).toMatchObject({ accepted: true, continuationTarget: "#general" });
  expect(sent).toHaveLength(2);
  expect(sent[1]).toMatchObject({
    operation: "send",
    target: "#general",
    content: "replacement body",
    idempotencyKey: sent[0]!.idempotencyKey,
  });
  expect(sent[1]!.sendDraft).toBeUndefined();
});

test("choice `b` reports an already-committed replay, not a fresh send", async () => {
  const { sent, client } = await fixture([
    transportHeld(),
    transportSent({ reason: "already_committed", messageId: "original-message-id" }),
  ]);
  const held = (await client.send("#general", "reply", {})) as Record<string, unknown>;
  const answer = (await client.continue(
    continuationOf(held)!.id,
    "b",
    "replacement body",
  )) as Record<string, unknown>;
  expect(answer).toMatchObject({
    accepted: true,
    replayedOriginal: true,
    messageId: "original-message-id",
    continuationTarget: "#general",
  });
  expect(sent).toHaveLength(2);
});

test("choice `c` discards the draft without reaching the transport", async () => {
  const { sent, client } = await fixture([transportHeld()]);
  const held = (await client.send("#general", "reply", {})) as Record<string, unknown>;
  const answer = (await client.continue(continuationOf(held)!.id, "c")) as Record<string, unknown>;
  expect(answer).toMatchObject({
    accepted: true,
    clearedDraft: true,
    continuationTarget: "#general",
  });
  expect(sent).toHaveLength(1);
});

test("choice `d` is refused when it was not offered", async () => {
  const { sent, client } = await fixture([transportHeld()]);
  const held = (await client.send("#general", "reply", {})) as Record<string, unknown>;
  const error = await client.continue(continuationOf(held)!.id, "d").catch((e: unknown) => e);
  expect(error).toMatchObject({ code: "CONTINUATION_CHOICE_NOT_OFFERED" });
  expect(sent).toHaveLength(1);
});

test("choice `d` resends the held draft anyway once offered", async () => {
  const { sent, client } = await fixture([
    transportHeld({ continueAnywaySuggested: true }),
    transportSent(),
  ]);
  const held = (await client.send("#general", "reply", {})) as Record<string, unknown>;
  const answer = (await client.continue(continuationOf(held)!.id, "d")) as Record<string, unknown>;
  expect(answer).toMatchObject({ accepted: true, continuationTarget: "#general" });
  expect(sent[1]).toMatchObject({
    sendDraft: true,
    continueAnyway: true,
    idempotencyKey: sent[0]!.idempotencyKey,
  });
});

test("a re-answered continuation reports already answered and never resends", async () => {
  const { sent, client } = await fixture([transportHeld()]);
  const held = (await client.send("#general", "reply", {})) as Record<string, unknown>;
  await client.continue(continuationOf(held)!.id, "c");
  const again = await client.continue(continuationOf(held)!.id, "a").catch((e: unknown) => e);
  expect(again).toMatchObject({ code: "CONTINUATION_ALREADY_ANSWERED" });
  expect(sent).toHaveLength(1);
});

test("an unknown continuation id is refused", async () => {
  const { client } = await fixture([]);
  const error = await client.continue("missing-id", "a").catch((e: unknown) => e);
  expect(error).toMatchObject({ code: "CONTINUATION_UNKNOWN" });
});

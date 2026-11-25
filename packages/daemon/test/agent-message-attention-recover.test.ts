import { expect, test } from "bun:test";
import { AgentNoticeSuppressedError, type AgentNoticeOptions } from "@coforge/agent";
import type { AgentRecoveryMessage } from "@lrm/coforge-sdk/internal";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { session } from "./fixtures/attention-delivery";

test("recover returns the targets it announced, and none when everything was already read", async () => {
  const notices: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async () => {},
  );
  const message = (target: string, sequence: number): AgentRecoveryMessage => ({
    messageId: `message-${target}-${sequence}`,
    deliveryId: `delivery-${target}-${sequence}`,
    conversationId: `conversation-${target}`,
    sequence,
    target,
    latestSenderKind: "human",
    latestSenderHandle: "alice",
    latestSenderDescription: "",
    body: "body",
  });

  // A new message and a summary-only target are announced.
  expect(await index.recover("agent-1", [message("#general", 1)], { "#ops": 2 })).toEqual(
    new Set(["#general", "#ops"]),
  );

  // The Agent already read #general up to sequence 5: nothing is left to announce for it, even
  // though the recovery names it, so it announces nothing and sends no notice.
  index.recordModelSeen("agent-1", "#research", 5);
  const before = notices.length;
  expect(
    await index.recover(
      "agent-1",
      [message("#research", 5)],
      { "#research": 1 },
      {
        "#research": "conversation-#research",
      },
    ),
  ).toEqual(new Set());
  expect(notices).toHaveLength(before);
});

test("a replacement session receives the same recovery IDs while duplicates stay deduplicated", async () => {
  const notices: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async () => {},
  );
  const message = {
    messageId: "message-recovery",
    deliveryId: "delivery-recovery",
    conversationId: "conversation-1",
    sequence: 1,
    target: "@ada",
    latestSenderKind: "human" as const,
    latestSenderHandle: "ada",
    latestSenderDescription: "",
    body: "recover this body",
  };
  const unreadIds = { "@ada": message.conversationId };
  await index.recover("agent-1", [message], { "@ada": 1 }, unreadIds);
  await index.recover("agent-1", [message], { "@ada": 1 }, unreadIds);
  index.clearAgent("agent-1");
  await index.recover("agent-1", [message], { "@ada": 1 }, unreadIds);
  expect(notices).toHaveLength(2);
  expect(notices.every((notice) => notice.startsWith("[CoForge inbox notice:"))).toBe(true);
  expect(notices.every((notice) => notice.includes("@ada 1 new message"))).toBe(true);
  expect(notices.every((notice) => !notice.includes("recover this body"))).toBe(true);
  expect(index.modelSeenSequence("agent-1", "@ada")).toBe(0);
});

test("recovery does not submit an enumerated task that becomes read after admission", async () => {
  const admission = Promise.withResolvers<void>();
  const submit = Promise.withResolvers<void>();
  const notices: string[] = [];
  const runtime = {
    ...session(),
    async notify(text: string, options?: AgentNoticeOptions) {
      admission.resolve();
      await submit.promise;
      const next = options?.prepareSubmission ? options.prepareSubmission("prompt") : text;
      if (next === undefined) throw new AgentNoticeSuppressedError();
      notices.push(next);
    },
  };
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => runtime },
    async () => {},
  );
  const target = "#board:#98";
  const message: AgentRecoveryMessage = {
    messageId: "recovered",
    deliveryId: "recovered-delivery",
    conversationId: "conversation-1",
    sequence: 18,
    target,
    latestSenderKind: "human",
    latestSenderHandle: "ada",
    latestSenderDescription: "",
    body: "old notice",
  };
  const recovering = index.recover(
    "agent-1",
    [message],
    { [target]: 1 },
    {
      [target]: message.conversationId,
    },
  );
  await admission.promise;
  index.recordHistoryRead("agent-1", {
    spelling: target,
    target,
    through: 20,
    shown: [],
    scope: { target, conversationId: message.conversationId, channelType: "thread" },
  });
  submit.resolve();
  expect(await recovering).toEqual(new Set());
  expect(notices).toEqual([]);
  expect(index.check("agent-1")).toEqual([]);
});

test("a carried launch summary backed by exact deliveries retains only the fresh count at submission", async () => {
  const admission = Promise.withResolvers<void>();
  const submit = Promise.withResolvers<void>();
  const notices: string[] = [];
  const runtime = {
    ...session(),
    async notify(text: string, options?: AgentNoticeOptions) {
      admission.resolve();
      await submit.promise;
      const next = options?.prepareSubmission ? options.prepareSubmission("prompt") : text;
      if (next === undefined) throw new AgentNoticeSuppressedError();
      notices.push(next);
    },
  };
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => runtime },
    async () => {},
  );
  const agentId = "agent-1";
  const target = "#board:#98";
  const conversationId = "conversation-1";
  index.bindConversation(agentId, target, conversationId);
  const countedDeliveries = [12, 15].map((sequence) => ({
    messageId: `message-${sequence}`,
    deliveryId: `delivery-${sequence}`,
    target,
    conversationId,
    sequence,
  }));
  const recovering = index.recover(
    agentId,
    [],
    { [target]: 2 },
    { [target]: conversationId },
    undefined,
    undefined,
    {
      snapshotMessages: [],
      countedDeliveries,
      accepted() {},
    },
  );
  await admission.promise;
  index.recordModelSeen(agentId, target, 13);
  submit.resolve();
  expect(await recovering).toEqual(new Set([target]));
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain(`${target} 1 new message`);
  expect(notices[0]).not.toContain(`${target} 2 new messages`);
});

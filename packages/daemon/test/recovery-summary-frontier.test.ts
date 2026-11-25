import { expect, test } from "bun:test";
import { AgentNoticeSuppressedError, type AgentNoticeOptions } from "@coforge/agent";
import { settleForwardedTaskRead } from "#src/daemon-runtime/agent-history-read";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { carriedStart, mergeCarried } from "#src/daemon-runtime/provider-replay-recovery";
import { delivery, session } from "./fixtures/attention-delivery";

const agentId = "agent-1";
const target = "#board:#98";
const conversationId = "conversation-1";
const recovery = {
  unreadSummary: { [target]: 2 },
  unreadConversationIds: { [target]: conversationId },
  lastUnreadSequences: { [target]: 18 },
};

function taskRead(
  index: AgentMessageAttentionIndex,
  reader: string,
  conversation: string,
  through: number,
  exact?: number,
) {
  settleForwardedTaskRead(
    index,
    reader,
    exact === undefined ? { unread: "true" } : { around: "18" },
    {
      consumptionScope: {
        agentId: reader,
        target,
        conversationId: conversation,
        channelType: "thread",
      },
      messages: exact === undefined ? [] : [{ target, sequence: exact }],
      modelSeenUpToSeq: through,
      moreUnread: exact !== undefined,
    },
  );
}

test("a scoped summary is rechecked against the read frontier at the provider boundary", async () => {
  const admission = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const notices: string[] = [];
  const runtime = {
    ...session(),
    async notify(text: string, options?: AgentNoticeOptions) {
      admission.resolve();
      await release.promise;
      const ready = options?.prepareSubmission ? options.prepareSubmission("prompt") : text;
      if (ready === undefined) throw new AgentNoticeSuppressedError();
      notices.push(ready);
    },
  };
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => runtime },
    async () => {},
  );
  const recovering = index.recover(
    agentId,
    [],
    recovery.unreadSummary,
    recovery.unreadConversationIds,
    undefined,
    undefined,
    { snapshotMessages: [], lastUnreadSequences: recovery.lastUnreadSequences, accepted() {} },
  );
  await admission.promise;
  taskRead(index, agentId, conversationId, 18);
  release.resolve();
  expect(await recovering).toEqual(new Set());
  expect(notices).toEqual([]);
});

test("partial or exact reads, missing proof, and other scopes preserve the count", async () => {
  for (const scenario of [
    "partial",
    "exact",
    "legacy",
    "other-conversation",
    "other-agent",
  ] as const) {
    const notices: string[] = [];
    const index = new AgentMessageAttentionIndex(
      "workspace-1",
      { session: () => session((notice) => notices.push(notice)) },
      async () => {},
    );
    taskRead(
      index,
      scenario === "other-agent" ? "agent-2" : agentId,
      scenario === "other-conversation" ? "conversation-2" : conversationId,
      scenario === "partial" ? 17 : 18,
      scenario === "exact" ? 18 : undefined,
    );
    if (scenario === "exact")
      expect(index.noticeEligibility(agentId, { target, conversationId, sequence: 18 })).toEqual({
        disposition: "settle",
        basis: "exact_read",
      });
    expect(
      await index.recover(
        agentId,
        [],
        recovery.unreadSummary,
        recovery.unreadConversationIds,
        undefined,
        undefined,
        {
          snapshotMessages: [],
          lastUnreadSequences: scenario === "legacy" ? undefined : recovery.lastUnreadSequences,
          accepted() {},
        },
      ),
    ).toEqual(new Set([target]));
    expect(notices[0]).toContain(`${target} 2 new messages`);
  }
});

test("a settled summary is omitted from a mixed fallback notice", async () => {
  const other = "#board:#99";
  const notices: string[] = [];
  const runtime = {
    ...session(),
    async notify(text: string, options?: AgentNoticeOptions) {
      expect(text).toContain(`${target} 2 new messages`);
      taskRead(index, agentId, conversationId, 19);
      expect(options?.fallbackText).toBeDefined();
      notices.push(options?.fallbackText?.() ?? "");
    },
  };
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => runtime },
    async () => {},
  );
  const announced = await index.recover(
    agentId,
    [],
    { ...recovery.unreadSummary, [other]: 1 },
    recovery.unreadConversationIds,
    undefined,
    undefined,
    { snapshotMessages: [], lastUnreadSequences: recovery.lastUnreadSequences, accepted() {} },
  );
  expect(announced).toEqual(new Set([other]));
  expect(notices[0]).toContain(`${other} 1 new message`);
  expect(notices[0]).not.toContain(target);
});

test("carried recovery drops the proof if it changes or merges the covered count", () => {
  const start = { recovery };
  expect(carriedStart(start, []).recovery?.lastUnreadSequences).toEqual(
    recovery.lastUnreadSequences,
  );
  expect(
    carriedStart(start, [{ target, pendingCount: 1 }]).recovery?.lastUnreadSequences,
  ).toBeUndefined();
  expect(
    mergeCarried(start, { recovery: { unreadSummary: { [target]: 1 } } }).recovery
      ?.lastUnreadSequences,
  ).toBeUndefined();
  expect(
    mergeCarried(start, { recovery: { unreadSummary: { "#other": 1 } } }).recovery
      ?.lastUnreadSequences,
  ).toEqual(recovery.lastUnreadSequences);
});

test("a carried replacement row invalidates the upper bound even when the count agrees", async () => {
  const next = {
    ...delivery("replacement"),
    target,
    conversationId,
    sequence: 19,
  };
  const changed = carriedStart(
    { recovery },
    [{ target, pendingCount: 1, deliveries: [next] }],
    [],
    new Map([[target, 1]]),
  ).recovery!;
  expect(changed.unreadSummary).toEqual(recovery.unreadSummary);
  const notices: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async () => {},
  );
  taskRead(index, agentId, conversationId, 18);
  expect(
    await index.recover(
      agentId,
      [],
      changed.unreadSummary!,
      changed.unreadConversationIds,
      undefined,
      undefined,
      {
        snapshotMessages: [],
        countedDeliveries: changed.countedDeliveries,
        lastUnreadSequences: changed.lastUnreadSequences,
        accepted() {},
      },
    ),
  ).toEqual(new Set([target]));
  expect(notices[0]).toContain(`${target} 2 new messages`);
  expect(changed.lastUnreadSequences).toBeUndefined();
});

test("merge drops a bound for a target touched outside the other side's summary", () => {
  const next = {
    ...delivery("new"),
    target,
    conversationId,
    sequence: 19,
    latestSenderKind: "human" as const,
    latestSenderHandle: "ada",
    latestSenderDescription: "",
    body: "new delivery",
  };
  for (const other of [
    { recovery: { countedDeliveries: [next] } },
    { recovery: { resumeMessages: [next] } },
    { recovery: { wakeMessage: next } },
  ]) {
    expect(mergeCarried({ recovery }, other).recovery?.lastUnreadSequences).toBeUndefined();
    expect(mergeCarried(other, { recovery }).recovery?.lastUnreadSequences).toBeUndefined();
  }
});

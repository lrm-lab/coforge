import { expect, test } from "bun:test";
import type { AgentNoticeOptions, AgentRuntimeConfig } from "@coforge/agent";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import type { AgentRuntime } from "#src/agent-runtime/agent-process-manager";
import { AgentDeliveryGate } from "#src/daemon-runtime/agent-delivery-gate";
import { settleForwardedTaskRead } from "#src/daemon-runtime/agent-history-read";
import {
  AgentInboxCoordinator,
  type AgentInboxCoordinatorPorts,
} from "#src/daemon-runtime/agent-inbox-coordinator";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { observeRuntimeEvent } from "#src/daemon-runtime/runtime-event-observation";
import { unreadNoticeComposer } from "#src/daemon-runtime/important-unread-compose";
import { delivery, session } from "./fixtures/attention-delivery";

const agentId = "agent-1";
const target = "#runtime-optimization:#100";

function fallbackHarness() {
  const notices: Array<{ text: string; options?: AgentNoticeOptions }> = [];
  const runtimeSession = {
    ...session(),
    hasLiveTurn: false,
    async notify(text: string, options?: AgentNoticeOptions) {
      notices.push({ text, options });
    },
  };
  const attention = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => runtimeSession },
    async () => {},
  );
  const config: AgentRuntimeConfig = { provider: "kiro", model: "default", reasoning: "" };
  const runtime: AgentRuntime = { config, session: runtimeSession };
  const deliveryGate = new AgentDeliveryGate();
  const settled = Promise.withResolvers<{ ids: readonly string[]; accepted: boolean }>();
  const ports = {
    deliveryGate,
    isWorking: () => false,
    mentionDeliveries: { markUndelivered: () => {} },
  } as unknown as Parameters<typeof observeRuntimeEvent>[0];
  const coordinator = new AgentInboxCoordinator({
    deliveryGate,
    messageAttention: attention,
    processManager: { session: () => runtimeSession, restartConfig: () => undefined },
    mentionDeliveries: {
      settleRedelivery: (_agentId: string, ids: readonly string[], accepted: boolean) => {
        if (ids.length) settled.resolve({ ids, accepted });
      },
    },
  } as unknown as AgentInboxCoordinatorPorts);
  return {
    notices,
    attention,
    settled: settled.promise,
    hold({ text, options }: { text: string; options?: AgentNoticeOptions }) {
      observeRuntimeEvent(
        ports,
        agentId,
        { launchId: "launch" } as Parameters<typeof observeRuntimeEvent>[2],
        config,
        runtime,
        false,
        { type: "notice-undelivered", text, ...options },
      );
    },
    read(message: AgentMessageDelivery, upTo: number) {
      settleForwardedTaskRead(
        attention,
        agentId,
        { unread: "true" },
        {
          consumptionScope: {
            agentId,
            conversationId: message.conversationId,
            channelType: "thread",
            target,
          },
          messages: [],
          hasOlder: false,
          hasNewer: false,
          moreUnread: false,
          modelSeenUpToSeq: upTo,
        },
      );
    },
    release() {
      coordinator.releaseFallbackNotices(agentId);
    },
  };
}

const taskDelivery = (id: string, sequence: number, body: string) => ({
  ...delivery(id, "human", "ada"),
  target,
  sequence,
  body,
});

async function fallbackAfterRead(read: boolean) {
  const { attention, notices, ...harness } = fallbackHarness();
  const original = taskDelivery("task-reply", 13, "read task preview");
  await attention.receive(original);
  expect(notices).toHaveLength(1);
  expect(notices[0]?.text).toContain(target);
  harness.hold(notices[0]!);
  if (read) {
    harness.read(original, 18);
    expect(attention.hasSeen(agentId, target, 13)).toBe(true);
    expect(attention.check(agentId)).toEqual([]);
    await attention.receive({ ...original, deliveryId: "replay-id" });
    expect(notices).toHaveLength(1);
  }

  harness.release();
  return notices.map(({ text }) => text);
}

test("a task already read stays quiet when an accepted but undelivered notice is released", async () => {
  const notices = await fallbackAfterRead(true);
  expect(notices).toHaveLength(1);
});

test("an unread task retains its fallback notice after a refused steer", async () => {
  const notices = await fallbackAfterRead(false);
  expect(notices).toHaveLength(2);
  expect(notices[0]).toBe(notices[1]);
});

test("a mixed notice is rebuilt from the unread task preview and drains once", async () => {
  const { attention, notices, ...harness } = fallbackHarness();
  const read = taskDelivery("read", 13, "already covered task preview");
  const unread = taskDelivery("unread", 19, "still waiting task preview");
  await attention.flush(agentId, [read, unread]);
  expect(notices[0]?.text).toContain(read.body);
  expect(notices[0]?.text).toContain(unread.body);
  harness.hold(notices[0]!);
  harness.read(read, 18);
  harness.release();
  harness.release();
  expect(notices).toHaveLength(2);
  expect(notices[1]?.text).not.toContain(read.body);
  expect(notices[1]?.text).toContain(unread.body);
});

test("a read from another conversation cannot consume a waiting notice at the same target", async () => {
  const { attention, notices, ...harness } = fallbackHarness();
  const old = taskDelivery("old-conversation", 13, "old task preview");
  const recreated = {
    ...taskDelivery("new-conversation", 2, "new task preview"),
    conversationId: "recreated",
  };
  await attention.receive(recreated);
  harness.hold(notices[0]!);
  harness.read(old, 18);
  expect(attention.hasSeen(agentId, target, recreated.sequence)).toBe(true);
  harness.release();
  expect(notices).toHaveLength(2);
  expect(notices[1]?.text).toContain(recreated.body);
});

test("raw app and tracked-mention fallback notices preserve their own payloads", async () => {
  const { notices, settled, ...harness } = fallbackHarness();
  harness.read(taskDelivery("read", 13, "read task preview"), 18);
  harness.hold({ text: "New app item available. Run coforge inbox check." });
  harness.hold({ text: "tracked mention", options: { deliveryIds: ["tracked-id"] } });
  harness.release();
  harness.release();
  expect(notices).toEqual([
    { text: "New app item available. Run coforge inbox check.", options: undefined },
    { text: "tracked mention", options: { deliveryIds: ["tracked-id"] } },
  ]);
  expect(await settled).toEqual({ ids: ["tracked-id"], accepted: true });
});

test("a structured reliable retry uses the same task read reconciliation", () => {
  const { attention, notices, ...harness } = fallbackHarness();
  const read = taskDelivery("reliable-read", 13, "reliable read task preview");
  const unread = taskDelivery("reliable-unread", 19, "reliable waiting task preview");
  const compose = unreadNoticeComposer({
    queued: () => [],
    prefix: () => "",
    previewedInFull: () => false,
    eligibility: attention.noticeEligibility,
  });
  const attempt = compose(
    agentId,
    {
      agentId,
      key: "seq:19",
      highestSequence: 19,
      conversations: [],
      attempts: 0,
    },
    [read, unread],
  );
  expect(attempt?.text).toContain(read.body);
  harness.hold({ text: attempt!.text, options: { fallbackText: attempt!.fallbackText } });
  harness.read(read, 18);
  harness.release();
  harness.release();
  expect(notices).toHaveLength(1);
  expect(notices[0]?.text).toContain(unread.body);
  expect(notices[0]?.text).not.toContain(read.body);
});

test("ordinary task input admitted before a read is withdrawn at the final submission boundary", async () => {
  const { attention, notices, ...harness } = fallbackHarness();
  const task = taskDelivery("ordinary-before-submit", 13, "ordinary already read preview");
  await attention.receive(task);
  expect(notices).toHaveLength(1);
  const notice = notices[0]!;
  expect(notice.options?.prepareSubmission?.("prompt")).toContain(task.body);
  harness.read(task, 18);
  expect(notice.options?.prepareSubmission?.("prompt")).toBeUndefined();
  expect(notice.options?.fallbackText?.()).toBeUndefined();
});

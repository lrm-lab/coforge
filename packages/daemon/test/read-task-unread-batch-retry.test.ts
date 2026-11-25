import { expect, test } from "bun:test";
import { settleForwardedTaskRead } from "#src/daemon-runtime/agent-history-read";
import { forwardedTaskReadResponse } from "#src/daemon-runtime/forwarded-task-read-response";
import { IMPORTANT_UNREAD_RETRY_DELAYS_MS } from "#src/daemon-runtime/important-unread-notice";
import { ImportantUnreadSweep } from "#src/daemon-runtime/important-unread-sweep";
import { delivery } from "./fixtures/attention-delivery";
import { settled, unreadLoop } from "./fixtures/unread-loop";
import { captureDaemonLogs } from "./log-capture";

test.each([false, true])(
  "the unread sweep preserves fresh messages with same conversation = %s",
  async (sameConversation) => {
    const task = {
      ...delivery("read-task", "agent", "runtime"),
      target: "#board:#98",
      conversationId: "task-conversation",
      sequence: 18,
      body: "old task preview " + "long text ".repeat(80),
      taskDiscussion: true,
    };
    const unread = {
      ...delivery("unread", "human", "owner"),
      target: sameConversation ? task.target : "@agent",
      conversationId: sameConversation ? task.conversationId : "other-conversation",
      sequence: sameConversation ? 24 : 100,
      taskDiscussion: sameConversation,
      body: "still unread " + "long text ".repeat(80),
    };

    const loop = unreadLoop({ cursor: true });
    const { records } = await captureDaemonLogs(async () => {
      await loop.index.flush(task.agentId, [task, unread]);
      expect(loop.loopNotices).toHaveLength(1);
      expect(loop.loopNotices[0]).toContain("old task preview");

      const response = await forwardedTaskReadResponse(
        {
          agentId: task.agentId,
          request: { route: "read", query: { unread: "true" } } as never,
          recordRead: (_agent, query, body) =>
            settleForwardedTaskRead(loop.index, task.agentId, query, body),
        },
        Response.json({
          consumptionScope: {
            agentId: task.agentId,
            conversationId: task.conversationId,
            channelType: "thread",
            target: task.target,
          },
          messages: [],
          hasOlder: false,
          hasNewer: false,
          moreUnread: false,
          readPositionAfter: 23,
          modelSeenUpToSeq: 23,
        }),
      );
      expect(response.ok).toBe(true);
      expect(loop.index.hasSeen(task.agentId, task.target, 18, task.conversationId)).toBe(true);
      expect(
        loop.index.hasSeen(unread.agentId, unread.target, unread.sequence, unread.conversationId),
      ).toBe(false);

      loop.clock.nowMs += IMPORTANT_UNREAD_RETRY_DELAYS_MS[0];
      new ImportantUnreadSweep({ flushDue: () => loop.reminder.flushDue() }).sweep();
      await settled();
    });

    const events = records.map((record) => record.properties);
    expect(events.filter(({ event }) => event === "agent.inbox_notice.accepted")).toHaveLength(1);
    expect(events.find(({ event }) => event === "agent.task_read.recorded")).toMatchObject({
      target: task.target,
      model_seen_up_to_seq: 23,
      read_position_after: 23,
    });
    expect(loop.loopNotices).toHaveLength(2);
    expect(loop.loopNotices[1]).toContain("still unread");
    expect(loop.loopNotices[1]).not.toContain("old task preview");
  },
);

test("reading a higher sequence in another conversation does not clear an unread task's retry", async () => {
  const unread = {
    ...delivery("unread-task", "human", "owner"),
    target: "#board:#98",
    conversationId: "unread-task-conversation",
    sequence: 18,
    body: "still unread task " + "long text ".repeat(80),
    taskDiscussion: true,
  };
  const read = {
    ...delivery("read-task-high", "agent", "runtime"),
    target: "#board:#99",
    conversationId: "read-task-conversation",
    sequence: 100,
    body: "read task at high sequence " + "long text ".repeat(80),
    taskDiscussion: true,
  };
  const loop = unreadLoop({ cursor: true });
  await loop.index.flush(read.agentId, [unread, read]);
  settleForwardedTaskRead(
    loop.index,
    read.agentId,
    { unread: "true" },
    {
      consumptionScope: {
        agentId: read.agentId,
        conversationId: read.conversationId,
        channelType: "thread",
        target: read.target,
      },
      messages: [],
      hasOlder: false,
      hasNewer: false,
      moreUnread: false,
      modelSeenUpToSeq: 105,
    },
  );
  expect(loop.index.hasSeen(read.agentId, read.target, read.sequence, read.conversationId)).toBe(
    true,
  );
  expect(
    loop.index.hasSeen(unread.agentId, unread.target, unread.sequence, unread.conversationId),
  ).toBe(false);
  loop.clock.nowMs += IMPORTANT_UNREAD_RETRY_DELAYS_MS[0];
  new ImportantUnreadSweep({ flushDue: () => loop.reminder.flushDue() }).sweep();
  await settled();
  expect(loop.loopNotices).toHaveLength(2);
  expect(loop.loopNotices[1]).toContain("still unread task");
  expect(loop.loopNotices[1]).not.toContain("read task at high sequence");
});

test("a task retired as read before attempt cannot reappear from the queue in a later reliable retry", async () => {
  const task = {
    ...delivery("read-before-attempt", "agent", "runtime"),
    target: "#board:#98",
    conversationId: "task-conversation",
    sequence: 25,
    body: "retired task preview " + "long text ".repeat(80),
    taskDiscussion: true,
  };
  const fresh = {
    ...delivery("new-reliable", "human", "owner"),
    target: "@agent",
    conversationId: "new-conversation",
    sequence: 100,
    body: "new reliable text",
  };
  let refusals = 2;
  const loop = unreadLoop({ cursor: true, refuse: () => refusals-- > 0 });
  const { records } = await captureDaemonLogs(async () => {
    await expect(loop.index.receive(task)).rejects.toThrow("refused");
    loop.queue.push(task);
    settleForwardedTaskRead(
      loop.index,
      task.agentId,
      { unread: "true" },
      {
        consumptionScope: {
          agentId: task.agentId,
          conversationId: task.conversationId,
          channelType: "thread",
          target: task.target,
        },
        messages: [],
        hasOlder: false,
        hasNewer: false,
        moreUnread: false,
        modelSeenUpToSeq: 27,
      },
    );
    expect(loop.index.hasSeen(task.agentId, task.target, task.sequence, task.conversationId)).toBe(
      true,
    );
    await expect(loop.index.receive(fresh)).rejects.toThrow("refused");

    loop.clock.nowMs += IMPORTANT_UNREAD_RETRY_DELAYS_MS[0];
    new ImportantUnreadSweep({ flushDue: () => loop.reminder.flushDue() }).sweep();
    await settled();
  });

  expect(
    records.filter(({ properties }) => properties.event === "agent.inbox_notice.unobserved"),
  ).toEqual([
    expect.objectContaining({
      properties: expect.objectContaining({
        reason: "read_before_attempt",
        delivery_id: task.deliveryId,
      }),
    }),
  ]);
  expect(loop.loopNotices).toHaveLength(1);
  expect(loop.loopNotices[0]).toContain("new reliable text");
  expect(loop.loopNotices[0]).not.toContain("retired task preview");
});

test("consumption after admission request suppresses a pure stale notice at provider submission", async () => {
  const task = {
    ...delivery("stale-at-submit", "human", "owner"),
    target: "#board:#98",
    conversationId: "task-conversation",
    sequence: 25,
    body: "already read preview " + "long text ".repeat(80),
    taskDiscussion: true,
  };
  const admission = Promise.withResolvers<void>();
  const submit = Promise.withResolvers<void>();
  const loop = unreadLoop({
    cursor: true,
    beforeSubmit: () => {
      admission.resolve();
      return submit.promise;
    },
  });

  const { records } = await captureDaemonLogs(async () => {
    const delivering = loop.index.receive(task);
    await admission.promise;
    settleForwardedTaskRead(
      loop.index,
      task.agentId,
      { unread: "true" },
      {
        consumptionScope: {
          agentId: task.agentId,
          conversationId: task.conversationId,
          channelType: "thread",
          target: task.target,
        },
        messages: [],
        hasOlder: false,
        hasNewer: false,
        moreUnread: false,
        modelSeenUpToSeq: 27,
      },
    );
    expect(loop.index.check(task.agentId)).toEqual([]);
    submit.resolve();
    await delivering;
  });
  expect(loop.loopNotices).toEqual([]);
  expect(loop.records.size).toBe(0);
  const events = records.map((record) => record.properties);
  expect(events.some(({ event }) => event === "agent.inbox_notice.admission_requested")).toBe(true);
  expect(events.some(({ event }) => event === "agent.inbox_notice.accepted")).toBe(false);
  expect(
    events.find(({ event }) => event === "agent.inbox_notice.submission_decision"),
  ).toMatchObject({
    request_ids: [task.requestId],
    boundary: "prompt",
    outcome: "suppress",
  });
});

test("a reliable sweep cannot queue another copy while the current admission is pending", async () => {
  const task = {
    ...delivery("inflight", "human", "owner"),
    target: "#board:#98",
    conversationId: "task-conversation",
    sequence: 25,
    taskDiscussion: true,
  };
  const admission = Promise.withResolvers<void>();
  const submit = Promise.withResolvers<void>();
  let offers = 0;
  const loop = unreadLoop({
    cursor: true,
    beforeSubmit: () => {
      offers++;
      admission.resolve();
      return submit.promise;
    },
  });
  const delivering = loop.index.receive(task);
  await admission.promise;
  loop.clock.nowMs += IMPORTANT_UNREAD_RETRY_DELAYS_MS[0];
  new ImportantUnreadSweep({ flushDue: () => loop.reminder.flushDue() }).sweep();
  const attempted = offers;
  submit.resolve();
  await delivering;
  await settled();
  expect(attempted).toBe(1);
  expect(loop.loopNotices).toHaveLength(1);
});

test("exact scoped reads can retire a small batch without an advanced frontier", async () => {
  const loop = unreadLoop({ cursor: true });
  const task = {
    ...delivery("exact-12", "human", "owner"),
    target: "#board:#98",
    sequence: 12,
    taskDiscussion: true,
  };
  await loop.index.flush(task.agentId, [
    task,
    { ...task, ...delivery("exact-15", "human", "owner"), target: task.target, sequence: 15 },
  ]);
  for (const sequence of [12, 15]) {
    loop.index.recordHistoryRead(task.agentId, {
      spelling: task.target,
      target: task.target,
      shown: [sequence],
      through: 0,
    });
  }
  expect(loop.index.modelSeenSequence(task.agentId, task.target)).toBe(0);
  expect(loop.records.size).toBe(0);
  loop.clock.nowMs += IMPORTANT_UNREAD_RETRY_DELAYS_MS[0];
  loop.reminder.flushDue();
  await settled();
  expect(loop.loopNotices).toHaveLength(1);
});

test.each([undefined, 15])(
  "a restored scoped notice covered by the cursor stays silent",
  async (lastSequence) => {
    const agentId = "agent-1";
    const target = "#board:#98";
    const conversationId = "conversation-1";
    const loop = unreadLoop({
      cursor: true,
      restored: [
        {
          agentId,
          key: "seq:100",
          highestSequence: 100,
          conversations: [{ target, conversationId, firstSequence: 15, lastSequence, count: 1 }],
          attempts: 1,
        },
      ],
    });
    loop.index.bindConversation(agentId, target, conversationId);
    loop.index.recordModelSeen(agentId, target, 21);
    loop.reminder.restore();
    loop.reminder.flushDue();
    await settled();
    expect(loop.records.size).toBe(0);
    expect(loop.loopNotices).toHaveLength(0);
  },
);

test("a card response wakes once even when the underlying card is already read", async () => {
  const loop = unreadLoop({ cursor: true });
  const event = {
    ...delivery("card-choice", "human", "owner"),
    target: "#board:#98",
    sequence: 18,
    body: "the card was answered",
    reason: "choice",
  };
  loop.index.bindConversation(event.agentId, event.target, event.conversationId);
  loop.index.recordModelSeen(event.agentId, event.target, 21);
  await loop.index.receive(event);
  expect(loop.loopNotices).toHaveLength(1);
  loop.clock.nowMs += IMPORTANT_UNREAD_RETRY_DELAYS_MS[0];
  loop.reminder.flushDue();
  await settled();
  expect(loop.loopNotices).toHaveLength(1);
  expect(loop.reported).toEqual([]);
});

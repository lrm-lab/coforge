import { expect, test } from "bun:test";
import type { AgentTaskIdleNudgeRequest } from "@lrm/coforge-sdk/agent";
import { idleNudge } from "#src/server/tasks/task-idle-reminder.server";
import { TaskConversations } from "#src/server/tasks/task-conversations.server";
import { setup } from "./fixtures/task-dependencies";

/**
 * The idle task reminder (task #421) against real PostgreSQL: which of an Agent's open Tasks
 * `POST /api/agent/v1/tasks/idle-nudge` names and why, when it names none, the hourly cap, the
 * order and the text. Time moves by passing a later `now`; nothing sleeps.
 */

const HOUR = 3_600_000;

async function world(options: { tasksV2?: boolean } = {}) {
  const fixture = await setup(options);
  const { db, principals, channel, one } = fixture;
  // `hours` from the real time of the call, so a reminder is recorded after what came before it.
  const at = (hours: number) => new Date(Date.now() + hours * HOUR);
  const nudge = (input: AgentTaskIdleNudgeRequest = {}, hours = 0, who: "one" | "two" = "one") =>
    idleNudge(db, principals[who] as { workspaceId: string; agentId: string }, input, at(hours));
  const conversations = new TaskConversations({ db, reader: "agent", dependencies: {} });
  const reply = (who: "one" | "two", number: number, body = "a note") =>
    conversations.reply(principals[who], { target: `#${channel.channelName}`, number }, { body });
  const assign = (number: number, agent = one) =>
    fixture.run("alice", { operation: "assign", number, assignee: `agent:${agent.id}` });
  const ref = (number: number) => `#${channel.channelName}:#${number}`;
  return { ...fixture, nudge, reply, assign, ref, at };
}

test("with Tasks v2 off nothing is sent", async () => {
  const { db, make, assign, nudge } = await world({ tasksV2: false });
  try {
    const [task] = await make("alice", 1);
    await assign(task!);
    expect(await nudge()).toEqual({
      send: false,
      reason: "disabled",
      items: [],
      backlog: [],
      text: "",
    });
  } finally {
    await db.$disconnect();
  }
});

test("an Agent with no open Task gets no_open_tasks, even in a fresh session", async () => {
  const { db, make, assign, run, nudge } = await world();
  try {
    const [task] = await make("alice", 1);
    await assign(task!);
    await run("alice", { operation: "update", number: task!, status: "done" });
    expect(await nudge()).toMatchObject({ send: false, reason: "no_open_tasks" });
    expect(await nudge({ freshSession: true })).toMatchObject({
      send: false,
      reason: "no_open_tasks",
    });
  } finally {
    await db.$disconnect();
  }
});

test("a newly assigned Task is named once; asking again is no_change; a fresh session names it again", async () => {
  const { db, make, assign, nudge, ref } = await world();
  try {
    const [task] = await make("alice", 1, { priority: "high" });
    await assign(task!);
    const first = await nudge();
    expect(first).toMatchObject({
      send: true,
      items: [
        {
          ref: ref(task!),
          taskNumber: task,
          status: "todo",
          priority: "high",
          reason: "newly_assigned",
          why: "newly assigned to you",
        },
      ],
      backlog: [],
    });
    expect(first.reason).toBeUndefined();
    expect(await nudge({}, 0.1)).toMatchObject({ send: false, reason: "hourly_cap" });
    expect(await nudge({}, 1.1)).toMatchObject({ send: false, reason: "no_change" });
    // A fresh session forgets everything, so it is told again, inside the hour.
    const fresh = await nudge({ freshSession: true }, 1.2);
    expect(fresh).toMatchObject({ send: true, items: [{ reason: "new_session" }] });
  } finally {
    await db.$disconnect();
  }
});

test("a Task the Agent claimed itself is not newly assigned; others' replies and changes are", async () => {
  const { db, make, run, nudge, reply } = await world();
  try {
    const [task] = await make("alice", 1);
    await run("one", { operation: "claim", number: task! });
    expect(await nudge()).toMatchObject({ send: false, reason: "no_change" });

    // Its own reply is not someone else's.
    await reply("one", task!);
    expect(await nudge()).toMatchObject({ send: false, reason: "no_change" });

    await reply("two", task!);
    expect(await nudge()).toMatchObject({
      send: true,
      items: [{ reason: "others_acted", why: "someone else replied in its conversation" }],
    });

    await run("alice", { operation: "update", number: task!, priority: "urgent" });
    expect(await nudge({}, 1.1)).toMatchObject({
      send: true,
      items: [{ reason: "others_acted", priority: "urgent", why: "someone else changed it" }],
    });
  } finally {
    await db.$disconnect();
  }
});

test("one reminder an hour, except for a fresh session", async () => {
  const { db, make, assign, nudge } = await world();
  try {
    const [a, b] = await make("alice", 2);
    await assign(a!);
    expect(await nudge()).toMatchObject({ send: true, items: [{ taskNumber: a }] });
    await assign(b!);
    expect(await nudge({}, 0.5)).toMatchObject({ send: false, reason: "hourly_cap" });
    expect(await nudge({}, 1.01)).toMatchObject({ send: true, items: [{ taskNumber: b }] });
    expect(await nudge({ freshSession: true }, 1.02)).toMatchObject({ send: true });
  } finally {
    await db.$disconnect();
  }
});

test("a quiet Task is stale after 24 hours, once a day, and never while background tasks run", async () => {
  const { db, make, run, nudge } = await world();
  try {
    const [task] = await make("alice", 1);
    await run("one", { operation: "claim", number: task! });
    expect(await nudge({}, 23)).toMatchObject({ send: false, reason: "no_change" });
    expect(await nudge({ backgroundTasks: 2 }, 25)).toMatchObject({
      send: false,
      reason: "no_change",
    });
    expect(await nudge({}, 25)).toMatchObject({
      send: true,
      items: [{ reason: "stale", status: "in_progress", why: "no activity for 24 hours" }],
    });
    expect(await nudge({}, 30)).toMatchObject({ send: false, reason: "no_change" });
    expect(await nudge({}, 49.5)).toMatchObject({ send: true, items: [{ reason: "stale" }] });
  } finally {
    await db.$disconnect();
  }
});

test("in review: the Agent's own submission waits for others; someone else's is like todo", async () => {
  const { db, make, assign, run, nudge, reply } = await world();
  try {
    const [own, given] = await make("alice", 2);
    await run("one", { operation: "claim", number: own! });
    await run("one", { operation: "update", number: own!, status: "in_review" });
    await assign(given!);
    await run("alice", { operation: "update", number: given!, status: "in_review" });

    // Only the Task someone else put in review is named, newly assigned.
    expect(await nudge()).toMatchObject({ send: true, items: [{ taskNumber: given }] });
    // A fresh session does not name the Agent's own submission either.
    const fresh = await nudge({ freshSession: true }, 0.1);
    expect(fresh.items.map((item) => item.taskNumber)).toEqual([given]);

    // A reviewer's reply on its own submission names it.
    await reply("two", own!);
    expect(await nudge({}, 1.5)).toMatchObject({
      send: true,
      items: [{ taskNumber: own, status: "in_review", reason: "others_acted" }],
    });

    // A day later only the other one is stale.
    const later = await nudge({}, 26.5);
    expect(later.items.map((item) => [item.taskNumber, item.reason])).toEqual([[given, "stale"]]);
  } finally {
    await db.$disconnect();
  }
});

test("a blocked Task is never stale; its blocker finishing names it once", async () => {
  const { db, make, assign, run, nudge, finish, ref } = await world();
  try {
    const [waiting, blocker] = await make("alice", 2);
    await run("alice", { operation: "amend", number: waiting!, blockedBy: [{ number: blocker! }] });
    await assign(waiting!);
    expect(await nudge()).toMatchObject({ send: true, items: [{ taskNumber: waiting }] });
    expect(await nudge({}, 25)).toMatchObject({ send: false, reason: "no_change" });

    await finish("two", blocker!);
    expect(await nudge({}, 1.5)).toMatchObject({
      send: true,
      items: [
        {
          taskNumber: waiting,
          reason: "others_acted",
          why: `the task it waits for, ${ref(blocker!)}, is done`,
        },
      ],
    });
    expect(await nudge({}, 3)).toMatchObject({ send: false, reason: "no_change" });
  } finally {
    await db.$disconnect();
  }
});

test("a parent with an unfinished subtask is never stale", async () => {
  const { db, make, assign, run, nudge, two } = await world();
  try {
    const [parent, child] = await make("alice", 2);
    await run("alice", { operation: "amend", number: child!, parent: { number: parent! } });
    await assign(parent!);
    await assign(child!, two);
    expect(await nudge()).toMatchObject({ send: true, items: [{ taskNumber: parent }] });
    expect(await nudge({}, 25)).toMatchObject({ send: false, reason: "no_change" });
  } finally {
    await db.$disconnect();
  }
});

test("highest priority first, oldest first within one; five listed, the rest in the backlog", async () => {
  const { db, make, assign, nudge, ref } = await world();
  try {
    const priorities = ["low", "none", "urgent", "medium", "high", "urgent", "none"] as const;
    const numbers: number[] = [];
    for (const priority of priorities) numbers.push(...(await make("alice", 1, { priority })));
    for (const number of numbers) await assign(number);
    const sent = await nudge();
    const [low, none1, urgent1, medium, high, urgent2, none2] = numbers;
    expect(sent.items.map((item) => item.taskNumber)).toEqual([
      urgent1,
      urgent2,
      high,
      medium,
      low,
    ]);
    expect(sent.backlog.map((item) => item.ref)).toEqual([ref(none1!), ref(none2!)]);
    const lines = sent.text.split("\n");
    expect(lines[0]).toBe(
      "[Idle task reminder] Open tasks assigned to you, highest priority first:",
    );
    expect(lines[1]).toBe(
      `- ${ref(urgent1!)} [todo] prio=urgent "${sent.items[0]!.title}" — newly assigned to you`,
    );
    expect(lines[6]).toBe(
      "Pick up the highest-priority one, or update a task's status if it is done or blocked. Read a task with `coforge task view '<ref>'`.",
    );
    expect(lines[7]).toBe(`(2 more: ${ref(none1!)}, ${ref(none2!)})`);
    expect(lines).toHaveLength(8);

    // The backlog was not reminded: the next hour lists it.
    const next = await nudge({}, 1.1);
    expect(next.items.map((item) => item.taskNumber)).toEqual([none1, none2]);
    expect(next.text).not.toContain("more:");
  } finally {
    await db.$disconnect();
  }
});

test("a blocker elsewhere is named only from a public channel, and only once none is left open", async () => {
  const { db, make, assign, run, nudge, other, secret } = await world();
  try {
    const [inOther] = await make("alice", 1, {}, other.id);
    const [inSecret] = await make("alice", 1, {}, secret.id);
    const [waiting] = await make("alice", 1, {
      blockedBy: [
        { number: inOther!, channel: other.channelName! },
        { number: inSecret!, channel: secret.channelName! },
      ],
    });
    await assign(waiting!);
    await nudge();

    // One of two finished: still blocked, nothing to say.
    await run("alice", { operation: "claim", number: inOther! }, other.id);
    await run("alice", { operation: "update", number: inOther!, status: "done" }, other.id);
    expect(await nudge({}, 1.5)).toMatchObject({ send: false, reason: "no_change" });

    // The last, in a private channel, is done: it is not named.
    await run("alice", { operation: "claim", number: inSecret! }, secret.id);
    await run("alice", { operation: "update", number: inSecret!, status: "done" }, secret.id);
    const sent = await nudge({}, 3);
    expect(sent.items).toMatchObject([
      { reason: "others_acted", why: "the task it waits for is done" },
    ]);
    expect(sent.text).not.toContain(secret.channelName!);
  } finally {
    await db.$disconnect();
  }
});

test("a Task never reminded counts only the last day as new", async () => {
  const { db, make, assign, run, nudge, reply } = await world();
  try {
    const [given, claimed] = await make("alice", 2);
    await assign(given!);
    await run("one", { operation: "claim", number: claimed! });
    await reply("two", claimed!);
    // The first ask, two days on: neither the assignment nor the reply is news; both are quiet.
    const first = await nudge({}, 48);
    expect(first.items.map((item) => [item.taskNumber, item.reason])).toEqual([
      [given, "stale"],
      [claimed, "stale"],
    ]);
  } finally {
    await db.$disconnect();
  }
});

test("a server-recorded change is nobody's, and a fresh session's send starts the hour", async () => {
  const { db, make, run, nudge, channel } = await world();
  try {
    const [task] = await make("alice", 1);
    await run("one", { operation: "claim", number: task! });
    expect(await nudge({ freshSession: true })).toMatchObject({ send: true });
    expect(await nudge({}, 0.5)).toMatchObject({ send: false, reason: "hourly_cap" });

    // A label merge records `system` events: not someone else acting on the Task.
    const { id } = await db.task.findFirstOrThrow({
      where: { conversationId: channel.id, number: task! },
    });
    await db.taskHistoryEvent.create({
      data: {
        taskId: id,
        seq: 1_000,
        eventType: "labels_changed",
        actorType: "system",
        payload: {},
      },
    });
    expect(await nudge({}, 1.5)).toMatchObject({ send: false, reason: "no_change" });
  } finally {
    await db.$disconnect();
  }
});

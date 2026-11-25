import { expect, test } from "bun:test";
import type { AgentTaskIdleNudgeRequest } from "@lrm/coforge-sdk/agent";
import { readAgentStartOpenTasks } from "#src/server/db/repositories/agent-start-open-tasks.repositories.server";
import { idleNudge } from "#src/server/tasks/task-idle-reminder.server";
import { TaskConversations } from "#src/server/tasks/task-conversations.server";
import { setup } from "./fixtures/task-dependencies";

/**
 * The idle task reminder (task #421) against real PostgreSQL: which of an Agent's open Tasks
 * `POST /api/agent/v1/tasks/idle-nudge` names and why, when it names none, the hourly cap, the
 * order and the text. Time moves by passing a later `now`; nothing sleeps.
 */

const HOUR = 3_600_000;

async function world() {
  const fixture = await setup();
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

test("a fresh session sees reassignments and priority changes made between task reads", async () => {
  const { db, make, assign, run, nudge, two } = await world();
  try {
    const [old, promoted] = await make("alice", 2, { priority: "low" });
    await assign(old!);
    await assign(promoted!);
    expect((await nudge()).items.map((task) => task.taskNumber)).toEqual([old, promoted]);

    await assign(old!, two);
    await run("alice", { operation: "update", number: promoted!, priority: "urgent" });

    const fresh = await nudge({ freshSession: true }, 2);
    expect(fresh.items).toMatchObject([
      { taskNumber: promoted, priority: "urgent", queuePosition: 1 },
    ]);
    expect(fresh.text).toContain("when details are missing or the task has changed");
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

test("a blocked Task is never stale; its blocker finishing names it once", async () => {
  const { db, make, assign, run, nudge, finish, ref } = await world();
  try {
    const [waiting, blocker] = await make("alice", 2);
    await run("alice", { operation: "amend", number: waiting!, blockedBy: [{ number: blocker! }] });
    await assign(waiting!);
    // Still blocked, the Task is due but outside the queue: no position (task #716).
    const blocked = await nudge();
    expect(blocked).toMatchObject({ send: true, items: [{ taskNumber: waiting }] });
    expect(blocked.items[0]).not.toHaveProperty("queuePosition");
    expect(await nudge({}, 25)).toMatchObject({ send: false, reason: "no_change" });

    await finish("two", blocker!);
    const unblocked = await nudge({}, 1.5);
    expect(unblocked).toMatchObject({
      send: true,
      items: [
        {
          taskNumber: waiting,
          reason: "others_acted",
          why: `the task it waits for, ${ref(blocker!)}, is done`,
        },
      ],
    });
    // Unblocked it can start, so it is the Agent's whole queue: position 1.
    expect(unblocked.items[0]!.queuePosition).toBe(1);
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
    const priorities = ["low", undefined, "urgent", "medium", "high", "urgent", undefined] as const;
    const numbers: number[] = [];
    for (const priority of priorities) numbers.push(...(await make("alice", 1, { priority })));
    for (const number of numbers) await assign(number);
    const sent = await nudge();
    const [low, olderDefault, urgent1, medium, high, urgent2, newerDefault] = numbers;
    expect(sent.items.map((item) => item.taskNumber)).toEqual([
      urgent1,
      urgent2,
      high,
      olderDefault,
      medium,
    ]);
    // Every listed Task is actionable, so each carries its place in the Agent's queue.
    expect(sent.items.map((item) => item.queuePosition)).toEqual([1, 2, 3, 4, 5]);
    expect(sent.backlog.map((item) => item.ref)).toEqual([ref(newerDefault!), ref(low!)]);
    const lines = sent.text.split("\n");
    expect(lines[0]).toBe("[Idle task reminder] Your task queue first, then what waits on others:");
    expect(lines[1]).toBe(
      `- #1 ${ref(urgent1!)} [todo] prio=urgent "${sent.items[0]!.title}" — newly assigned to you`,
    );
    expect(lines[6]).toBe(
      "Pick up the first queued task that can proceed, or update a task's status if it is done or blocked. Respect any pending approval or acceptance. Reuse task details verified in this session. Read the selected task with `coforge task view '<ref>'` when details are missing or the task has changed.",
    );
    expect(lines[7]).toBe(`(2 more: ${ref(newerDefault!)}, ${ref(low!)})`);
    expect(lines).toHaveLength(8);

    // The backlog was not reminded: the next hour lists it, still at its true queue places.
    const next = await nudge({}, 1.1);
    expect(next.items.map((item) => item.taskNumber)).toEqual([newerDefault, low]);
    expect(next.items.map((item) => item.queuePosition)).toEqual([6, 7]);
    expect(next.text).not.toContain("more:");
  } finally {
    await db.$disconnect();
  }
});

test("queued work lists before what waits outside the queue, whatever its priority", async () => {
  const { db, make, assign, run, nudge } = await world();
  try {
    const [low, blocker] = await make("alice", 2, { priority: "low" });
    const [urgent] = await make("alice", 1, {
      priority: "urgent",
      blockedBy: [{ number: blocker! }],
    });
    await assign(low!);
    await assign(urgent!);
    const sent = await nudge();
    expect(sent.items.map((item) => [item.taskNumber, item.queuePosition ?? null])).toEqual([
      [low, 1],
      [urgent, null],
    ]);
    expect(sent.text).toContain("Pick up the first queued task");
    void run;
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

test("unassigned Todo Tasks created by the Agent surface once on idle and do not shift queued positions", async () => {
  const { db, make, assign, nudge, ref } = await world();
  try {
    const [owned] = await make("alice", 1, { priority: "low" });
    await assign(owned!);
    const [unassigned] = await make("one", 1, { priority: "urgent" });
    const sent = await nudge();
    expect(sent.send).toBe(true);
    expect(sent.items).toMatchObject([
      {
        ref: ref(owned!),
        taskNumber: owned,
        queuePosition: 1,
        reason: "newly_assigned",
      },
      {
        ref: ref(unassigned!),
        taskNumber: unassigned,
        reason: "newly_assigned",
        why: "created by you with no assignee",
      },
    ]);
    expect(sent.items[1]).not.toHaveProperty("queuePosition");
    expect(sent.text).toContain("claim or assign");
    expect(await nudge({}, 1.2)).toMatchObject({ send: false, reason: "no_change" });
  } finally {
    await db.$disconnect();
  }
});

for (const change of ["blocker", "reply"] as const) {
  test(`a fresh session reports a ${change} change to an already listed task`, async () => {
    const fixture = await world();
    const { db, make, run, finish, nudge, reply, ref, one, channel } = fixture;
    try {
      const [original, blocker] = await make("alice", 2);
      const number = original!;
      await run("one", { operation: "claim", number });
      if (change === "blocker")
        await run("alice", { operation: "amend", number, blockedBy: [{ number: blocker! }] });
      const startup = await readAgentStartOpenTasks(db, channel.workspaceId, one.id);
      const [listed] = startup?.tasks ?? [];
      expect(listed).toMatchObject({ ref: ref(number) });
      if (change === "blocker") await finish("two", blocker!);
      else await reply("two", number, "Changed during the startup turn");

      const answer = await nudge({ freshSession: true }, 0.01);
      expect(answer).toMatchObject({
        send: true,
        items: [
          {
            ...listed,
            reason: "others_acted",
            why:
              change === "blocker"
                ? `the task it waits for, ${ref(blocker!)}, is done`
                : "someone else replied in its conversation",
          },
        ],
      });
      expect(answer.text).toContain(answer.items[0]!.why);
      expect(await nudge({}, 2)).toMatchObject({ send: false, reason: "no_change" });
    } finally {
      await db.$disconnect();
    }
  });
}

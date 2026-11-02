import { test, expect } from "bun:test";
import type { TaskLink } from "@lrm/coforge-sdk/internal";
import type { TaskChangedSignal } from "#src/server/conversations/conversation-realtime.server";
import type { TaskBoard } from "#src/server/tasks/task-board.server";
import { setup } from "./fixtures/task-dependencies";

/** Blockers and parents across the channels of one Workspace, against real PostgreSQL. */

const visible = (link: TaskLink | null | undefined) => (link && !link.hidden ? link : undefined);

test("a blocker and a parent in another channel are named by channel, from both ends", async () => {
  const { db, board, principals, run, make, show, channel, other, refusal } = await setup();
  try {
    const [blocker, parent] = await make("alice", 2, {}, other.id);
    const [waiting] = await make("alice", 1, {
      blockedBy: [{ number: blocker!, channel: other.channelName! }],
      parent: { number: parent!, channel: other.channelName! },
    });
    const card = (await show(waiting!)).tasks[0]!;
    expect(card.blocked).toBe(true);
    expect(visible(card.blockedBy[0])).toMatchObject({
      number: blocker,
      channel: other.channelName,
      status: "todo",
    });
    expect(visible(card.parent)).toMatchObject({ number: parent, channel: other.channelName });

    // The other end sees this channel's tasks by this channel's name.
    const blocking = (await show(blocker!, other.id)).blocking!;
    expect(visible(blocking[0])).toMatchObject({ number: waiting, channel: channel.channelName });
    // The browser detail reads the same downstream list.
    const overview = await board.overviewTask(
      { workspaceId: principals.alice.workspaceId, userId: principals.alice.userId! },
      { conversationId: other.id, number: blocker! },
    );
    expect(visible(overview?.blocking?.[0])).toMatchObject({
      number: waiting,
      channel: channel.channelName,
    });
    const subtree = (await show(parent!, other.id)).subtree!;
    expect(subtree).toMatchObject([{ number: waiting, channel: channel.channelName }]);
    expect((await show(parent!, other.id)).tasks[0]!.subtasks).toEqual({ total: 1, finished: 0 });

    // Amending replaces the set; a number alone still names this conversation's task.
    const [local] = await make("alice", 1);
    const amended = await run("alice", {
      operation: "amend",
      number: waiting!,
      blockedBy: [{ number: local! }, { number: blocker!, channel: other.channelName! }],
      parent: null,
    });
    expect(amended.tasks[0]!.blockedBy.map((link) => visible(link)?.channel)).toEqual([
      null,
      other.channelName,
    ]);
    expect(amended.tasks[0]!.parent).toBeNull();
    expect(amended.history?.[0]).toMatchObject({ eventType: "dependencies_changed" });

    // A number in this conversation that exists only in the other one is refused.
    const missing = await refusal(
      run("alice", { operation: "amend", number: waiting!, blockedBy: [{ number: blocker! }] }),
    );
    expect(missing.code).toBe("INVALID_INPUT");
  } finally {
    await db.$disconnect();
  }
});

test("a private channel's task looks like one that does not exist to someone who cannot read it", async () => {
  const { db, run, make, secret, other, channel, refusal } = await setup();
  try {
    const [hidden] = await make("alice", 1, {}, secret.id);
    const [public_] = await make("alice", 1, {}, other.id);
    const named = (number: number, name: string) => ({ number, channel: name });
    // Agent two and Bob are not members of the private channel.
    for (const who of ["two", "bob"] as const) {
      const [mine] = await make(who, 1, { titles: [`mine ${who}`] });
      const toPrivate = await refusal(
        run(who, {
          operation: "amend",
          number: mine!,
          blockedBy: [named(hidden!, secret.channelName!)],
        }),
      );
      const toMissing = await refusal(
        run(who, {
          operation: "amend",
          number: mine!,
          blockedBy: [named(public_! + 40, other.channelName!)],
        }),
      );
      const toNoChannel = await refusal(
        run(who, { operation: "amend", number: mine!, parent: named(hidden!, "no-such-channel") }),
      );
      for (const error of [toPrivate, toMissing, toNoChannel]) {
        expect(error.code).toBe("INVALID_INPUT");
        expect(error.hint).toMatch(/^task #\S+ does not exist$/);
      }
      expect(toPrivate.hint).toBe(`task #${secret.channelName}/${hidden} does not exist`);
    }
    // A member of it may name it.
    const [mine] = await make("one", 1, { titles: ["mine one"] });
    const allowed = await run(
      "one",
      {
        operation: "amend",
        number: mine!,
        blockedBy: [named(hidden!, secret.channelName!)],
      },
      channel.id,
    );
    expect(allowed.tasks[0]!.blocked).toBe(true);
    // The write is accepted, and the answer names the blocker as hidden: the write's own
    // conversation is not the private channel's.
    expect(allowed.tasks[0]!.blockedBy).toEqual([{ hidden: true, status: "todo" }]);
  } finally {
    await db.$disconnect();
  }
});

test("a private channel's task is hidden in a view that is not its own channel's", async () => {
  const { db, run, make, show, secret, channel, refusal, one } = await setup();
  try {
    const [hidden] = await make("alice", 1, {}, secret.id);
    const [waiting] = await make("alice", 1, {
      blockedBy: [{ number: hidden!, channel: secret.channelName! }],
    });
    for (const who of ["alice", "bob"] as const) {
      const card = (await run(who, { operation: "show", number: waiting! }, channel.id)).tasks[0]!;
      expect(card.blockedBy).toEqual([{ hidden: true, status: "todo" }]);
      expect(card.blocked).toBe(true);
    }
    // From inside the private channel it is a task like any other.
    expect((await show(hidden!, secret.id)).blocking).toMatchObject([
      { hidden: false, number: waiting, channel: channel.channelName },
    ]);
    // The refusal that holds the dependent back does not name it either.
    const claim = (await run("bob", { operation: "claim", number: waiting! })).claims![0]!;
    expect(claim).toMatchObject({ success: false, reason: "blocked" });
    expect(claim.blockedBy).toEqual([{ hidden: true }]);
    await run("alice", { operation: "assign", number: waiting!, assignee: `agent:${one.id}` });
    const move = await refusal(
      run("one", { operation: "update", number: waiting!, status: "in_progress" }),
    );
    expect(move.errorId).toBe("task_blocked");
    expect(move.hint).toContain("a task in another channel");
    expect(move.hint).not.toContain(secret.channelName!);
  } finally {
    await db.$disconnect();
  }
});

test("a cycle through another channel is refused", async () => {
  const { db, run, make, other, channel, refusal } = await setup();
  try {
    const [a] = await make("alice", 1);
    const [b] = await make(
      "alice",
      1,
      { blockedBy: [{ number: a!, channel: channel.channelName! }] },
      other.id,
    );
    const cycle = await refusal(
      run("alice", {
        operation: "amend",
        number: a!,
        blockedBy: [{ number: b!, channel: other.channelName! }],
      }),
    );
    expect(cycle.code).toBe("INVALID_INPUT");
    expect(cycle.hint).toContain("cycle");

    const [parent] = await make("alice", 1, {}, other.id);
    await run("alice", {
      operation: "amend",
      number: a!,
      parent: { number: parent!, channel: other.channelName! },
    });
    const parents = await refusal(
      run(
        "alice",
        {
          operation: "amend",
          number: parent!,
          parent: { number: a!, channel: channel.channelName! },
        },
        other.id,
      ),
    );
    expect(parents.hint).toContain("below");
  } finally {
    await db.$disconnect();
  }
});

test("finishing a blocker in another channel tells the dependent's owner in the dependent's own channel", async () => {
  const { db, run, make, notices, one, other } = await setup();
  try {
    const [blocker] = await make("alice", 1, {}, other.id);
    const [waiting] = await make("alice", 1, {
      blockedBy: [{ number: blocker!, channel: other.channelName! }],
    });
    await run("alice", { operation: "assign", number: waiting!, assignee: `agent:${one.id}` });
    // Agent two finishes the blocker in the other channel.
    await run("two", { operation: "claim", number: blocker! }, other.id);
    await run("two", { operation: "update", number: blocker!, status: "in_review" }, other.id);
    await run("two", { operation: "update", number: blocker!, status: "done" }, other.id);
    const told = (await notices(waiting!)).filter((notice) => notice.kind === "task.unblocked");
    expect(told).toEqual([{ kind: "task.unblocked", agents: [one.id] }]);
    const message = await db.message.findFirstOrThrow({
      where: {
        systemMessage: { kind: "task.unblocked" },
        deliveries: { some: { agentId: one.id } },
      },
      select: { body: true },
    });
    expect(message.body).toContain(`#${other.channelName}/${blocker}`);
    expect(message.body).toContain(`#${waiting}`);
    // Nothing was posted in the blocker's channel for it.
    expect(
      await db.message.count({
        where: { conversationId: other.id, systemMessage: { kind: "task.unblocked" } },
      }),
    ).toBe(0);
  } finally {
    await db.$disconnect();
  }
});

test("a blocker's change announces its dependent to the dependent's own conversation", async () => {
  const announced: TaskChangedSignal[] = [];
  const { db, run, make, channel, other } = await setup({
    dependencies: {
      realtime: {
        async memberChanged() {},
        async messageAvailable() {},
        async taskChanged(signal) {
          announced.push(signal);
        },
      },
    },
  });
  try {
    const [blocker] = await make("alice", 1, {}, other.id);
    const [waiting] = await make("alice", 1, {
      blockedBy: [{ number: blocker!, channel: other.channelName! }],
    });
    await run("alice", { operation: "claim", number: blocker! }, other.id);
    announced.length = 0;
    await run("alice", { operation: "update", number: blocker!, status: "in_review" }, other.id);
    // The page open on the dependent's conversation hears of the blocker's change, with the new
    // status in the dependent's copy: its open detail refreshes without reading its list again.
    const toWaiting = announced.filter((signal) => signal.conversationId === channel.id);
    expect(toWaiting).toHaveLength(1);
    const [view] = toWaiting[0]!.tasks;
    expect(view).toMatchObject({ number: waiting, conversationId: channel.id });
    expect(view!.blockedBy).toMatchObject([
      { number: blocker, channel: other.channelName, status: "in_review" },
    ]);
  } finally {
    await db.$disconnect();
  }
});

test("a non-member of a public channel reads a Task's detail and downstream list", async () => {
  const { db, board, principals, make, channel, other } = await setup();
  try {
    const workspaceId = principals.alice.workspaceId;
    // A Workspace member who is not in the public channel the blocker lives in.
    const carol = await db.user.create({
      data: {
        displayName: "carol",
        username: `carol-${crypto.randomUUID().slice(0, 8)}`,
      },
    });
    await db.workspaceMembership.create({ data: { workspaceId, userId: carol.id } });
    const [blocker] = await make("alice", 1, {}, other.id);
    const [waiting] = await make("alice", 1, {
      blockedBy: [{ number: blocker!, channel: other.channelName! }],
    });
    const runAsCarol = (command: Record<string, unknown>) =>
      board.execute({ workspaceId, userId: carol.id }, {
        idempotencyKey: crypto.randomUUID(),
        conversationId: other.id,
        ...command,
      } as Parameters<TaskBoard["execute"]>[1]);
    // `show` carries the downstream list the detail shows; `history` its tab.
    const shown = await runAsCarol({ operation: "show", number: blocker });
    expect(shown.blocking).toMatchObject([{ number: waiting, channel: channel.channelName }]);
    expect((await runAsCarol({ operation: "history", number: blocker })).tasks).toHaveLength(1);
    // Reading does not widen into writing.
    await expect(runAsCarol({ operation: "claim", number: blocker })).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
  } finally {
    await db.$disconnect();
  }
});

test("a task cannot wait for its parent or its child", async () => {
  const { run, make, refusal } = await setup();
  const [parent] = await make("alice", 1);
  const [child] = await make("alice", 1, { parent: { number: parent! } });
  const upward = await refusal(
    run("alice", { operation: "amend", number: child!, blockedBy: [{ number: parent! }] }),
  );
  expect(upward.code).toBe("INVALID_INPUT");
  expect(upward.hint).toContain("ancestor");
  const downward = await refusal(
    run("alice", { operation: "amend", number: parent!, blockedBy: [{ number: child! }] }),
  );
  expect(downward.code).toBe("INVALID_INPUT");
  expect(downward.hint).toContain("descendant");
});

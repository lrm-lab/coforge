import { expect, test } from "bun:test";
import {
  BACKGROUND_TASK_SILENT_MS,
  BACKGROUND_TASK_START_SLACK_MS,
  OutstandingBackgroundTasks,
} from "#src/agent-runtime/subagent-progress-activity";
import { countLiveProcessDescendants } from "#src/agent-runtime/process-descendants";
import { TaskIdleNudge } from "#src/daemon-runtime/task-idle-nudge";
import { captureDaemonLogs } from "./log-capture";

test("reapZombies removes 60m-silent background tasks only when live OS descendants are zero", async () => {
  expect(BACKGROUND_TASK_SILENT_MS).toBe(60 * 60_000);
  let now = 1_000;
  let liveDescendants: number | undefined = 1;
  let probeCalls = 0;
  const tasks = new OutstandingBackgroundTasks({
    clock: () => now,
    identity: { agentId: "agent-a", launchId: "launch-1" },
    countLiveDescendants: async () => {
      probeCalls += 1;
      return liveDescendants;
    },
  });

  tasks.observe({ type: "subagent-progress", phase: "started", taskId: "task-1" });
  tasks.observe({ type: "subagent-progress", phase: "started", taskId: "task-2" });
  expect(tasks.count).toBe(2);

  // Before the 60m silence threshold, no OS descendant scan runs.
  now += BACKGROUND_TASK_SILENT_MS - 1;
  expect(await tasks.reapZombies()).toEqual([]);
  expect(probeCalls).toBe(0);
  expect(tasks.count).toBe(2);

  // Progress on task-2 refreshes its silence clock; task-1 crosses 60m.
  tasks.observe({ type: "subagent-progress", phase: "progress", taskId: "task-2" });
  now += 1;

  // Live descendants > 0 keeps silent tasks waiting.
  liveDescendants = 1;
  expect(await tasks.reapZombies()).toEqual([]);
  expect(probeCalls).toBe(1);
  expect(tasks.count).toBe(2);

  // Unobservable descendants (undefined) also keeps silent tasks rather than guessing.
  liveDescendants = undefined;
  expect(await tasks.reapZombies()).toEqual([]);
  expect(tasks.count).toBe(2);

  // Zero live descendants reaps only the silent task (task-1) and logs once.
  liveDescendants = 0;
  const { records } = await captureDaemonLogs(async () => {
    expect(await tasks.reapZombies()).toEqual(["task-1"]);
  });
  expect(tasks.count).toBe(1);
  expect(tasks.quietDetail()).toBe("Waiting for 1 background task");
  const reapedLog = records.find(
    (entry) => entry.properties.event === "agent_runtime:background_task_reaped",
  );
  expect(reapedLog?.properties).toMatchObject({
    agent_id: "agent-a",
    launch_id: "launch-1",
    reaped_count: 1,
    remaining_count: 1,
  });

  // Once task-2 also crosses 60m with zero descendants, quietDetail clears completely.
  now += BACKGROUND_TASK_SILENT_MS;
  expect(await tasks.reapZombies()).toEqual(["task-2"]);
  expect(tasks.count).toBe(0);
  expect(tasks.quietDetail()).toBeUndefined();
});

test("reapZombies spares a task that reported progress while the descendant scan was in flight", async () => {
  let now = 0;
  const tasks = new OutstandingBackgroundTasks({
    clock: () => now,
    silentThresholdMs: 10_000,
    countLiveDescendants: async () => {
      now += 100;
      tasks.observe({ type: "subagent-progress", phase: "progress", taskId: "task-1" });
      return 0;
    },
  });
  tasks.observe({ type: "subagent-progress", phase: "started", taskId: "task-1" });
  now = 10_000;
  expect(await tasks.reapZombies()).toEqual([]);
  expect(tasks.count).toBe(1);
});

test("TaskIdleNudge reaps zombie background tasks before asking so stale reminders are not suppressed forever", async () => {
  let now = 0;
  const tasks = new OutstandingBackgroundTasks({
    clock: () => now,
    countLiveDescendants: async () => 0,
  });
  tasks.observe({ type: "subagent-progress", phase: "started", taskId: "zombie-1" });
  now = BACKGROUND_TASK_SILENT_MS;

  const asks: Array<Record<string, unknown>> = [];
  const nudge = new TaskIdleNudge({
    ask: async (_agentId, request) => {
      asks.push(request);
      return { send: false, reason: "none" };
    },
    idle: () => true,
    backgroundTasks: () => tasks.count,
    reapBackgroundTasks: async () => {
      await tasks.reapZombies();
    },
    sessionId: () => "session-1",
    freshSession: () => false,
    deliver: async () => true,
    now: () => now,
  });

  nudge.maybeAsk("agent-a");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(tasks.count).toBe(0);
  expect(asks).toEqual([{}]);
});

test("reapZombies ignores pre-existing MCP children, keeps unknown/recent children, and ignores sleep time", async () => {
  let awakeMs = 1_000;
  let procClockMs = 200_000;
  let table: Array<{ pid: number; ppid: number; startedAtMs: number }> = [
    { pid: 100, ppid: 1, startedAtMs: 10_000 },
    { pid: 200, ppid: 100, startedAtMs: 15_000 },
  ];

  const tasks = new OutstandingBackgroundTasks({
    clock: () => awakeMs,
    processClock: () => procClockMs,
    countLiveDescendants: (startedAfterMs) =>
      countLiveProcessDescendants(100, {
        startedAfterMs,
        processTable: {
          list: async () => table.map((e) => ({ ...e, command: "node" })),
          resolutionMs: 1_000,
        },
      }),
  });

  tasks.observe({ type: "subagent-progress", phase: "started", taskId: "bg-1" });

  // Sleeping 2 hours advances wall clock, not awakeClockMs: task is not silent and not reaped.
  awakeMs += 30_000;
  expect(await tasks.reapZombies()).toEqual([]);
  expect(tasks.count).toBe(1);

  // Advance awake time past 60m threshold:
  awakeMs += BACKGROUND_TASK_SILENT_MS;

  // Child with unknown startedAtMs keeps the task alive.
  table.push({ pid: 201, ppid: 100, startedAtMs: 0 });
  expect(await tasks.reapZombies()).toEqual([]);
  expect(tasks.count).toBe(1);

  // Child started within the 60s slack before task start keeps the task alive.
  table = [
    { pid: 100, ppid: 1, startedAtMs: 10_000 },
    { pid: 200, ppid: 100, startedAtMs: 15_000 },
    { pid: 202, ppid: 100, startedAtMs: 200_000 - BACKGROUND_TASK_START_SLACK_MS },
  ];
  expect(await tasks.reapZombies()).toEqual([]);
  expect(tasks.count).toBe(1);

  // Only pre-existing MCP child (started before taskStart - 60s) remains: reaps zombie task.
  table = [
    { pid: 100, ppid: 1, startedAtMs: 10_000 },
    { pid: 200, ppid: 100, startedAtMs: 15_000 },
  ];
  expect(await tasks.reapZombies()).toEqual(["bg-1"]);
  expect(tasks.count).toBe(0);
});

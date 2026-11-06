import { expect, test } from "bun:test";
import { tmpdir } from "node:os";

import { type AgentRuntimeEvent, type AgentSubagentTaskKind } from "@lrm/coforge-anvil";

import {
  claudeFixtureProvider,
  controlledClaude,
  TEST_AGENT_INSTRUCTIONS,
  waitForEvent,
} from "./fixtures/claude-feed";

test("Claude Code relays every non-ambient task's lifecycle as subagent-progress", async () => {
  // Shaped like Claude Code 2.1.300 stream-json: a foreground subagent, then a background Bash
  // task, whose `task_notification` names no type, so only `task_started` tells them apart.
  const fixture = await controlledClaude();
  const { session, emit } = fixture;
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.sendMessage("wait");
    await emit(
      {
        type: "system",
        subtype: "task_started",
        task_id: "task-agent",
        tool_use_id: "toolu_agent",
        description: "Read a.txt contents",
        subagent_type: "general-purpose",
        is_backgrounded: false,
        task_type: "local_agent",
      },
      {
        type: "system",
        subtype: "task_progress",
        task_id: "task-agent",
        tool_use_id: "toolu_agent",
        description: "Reading a.txt",
        subagent_type: "general-purpose",
        last_tool_name: "Read",
      },
      {
        // Claude Code's own bookkeeping task: the SDK says to keep ambient tasks out of
        // activity indicators.
        type: "system",
        subtype: "task_started",
        task_id: "task-ambient",
        description: "Watch for updates",
        task_type: "local_agent",
        ambient: true,
      },
      {
        type: "system",
        subtype: "task_notification",
        task_id: "task-ambient",
        status: "stopped",
        summary: "stopped",
      },
      {
        type: "system",
        subtype: "task_started",
        task_id: "task-bash",
        tool_use_id: "toolu_bash",
        description: "Run sleep then echo hi in background",
        is_backgrounded: true,
        task_type: "local_bash",
      },
      {
        type: "system",
        subtype: "task_notification",
        task_id: "task-bash",
        tool_use_id: "toolu_bash",
        status: "completed",
        summary: "Background command completed (exit code 0)",
      },
      {
        type: "system",
        subtype: "task_notification",
        task_id: "task-agent",
        tool_use_id: "toolu_agent",
        status: "completed",
        summary: "a.txt contains hello",
      },
    );
    await waitForEvent(events, "subagent-progress");
    await Bun.sleep(20);
    type TaskRow = {
      phase: "started" | "progress" | "notification";
      taskId: string | undefined;
      type: string | undefined;
      parent: string | undefined;
      status: "completed" | "failed" | "stopped" | undefined;
      kind: AgentSubagentTaskKind | undefined;
    };
    const rows: TaskRow[] = events.flatMap((event) =>
      event.type === "subagent-progress"
        ? [
            {
              phase: event.phase,
              taskId: event.taskId,
              type: event.subagentType,
              parent: event.parentToolUseId,
              status: event.taskStatus,
              kind: event.taskKind,
            },
          ]
        : [],
    );
    const expected: TaskRow[] = [
      ...(["started", "progress"] as const).map((phase) => ({
        phase,
        taskId: "task-agent",
        type: "general-purpose",
        parent: "toolu_agent",
        status: undefined,
        kind: "agent" as const,
      })),
      // A background command is a task too, with its rows, as in the reference client.
      {
        phase: "started",
        taskId: "task-bash",
        type: undefined,
        parent: "toolu_bash",
        status: undefined,
        kind: "command" as const,
      },
      {
        phase: "notification",
        taskId: "task-bash",
        type: undefined,
        parent: "toolu_bash",
        status: "completed",
        kind: "command" as const,
      },
      {
        phase: "notification",
        taskId: "task-agent",
        type: "general-purpose",
        parent: "toolu_agent",
        status: "completed",
        kind: "agent" as const,
      },
    ];
    expect(rows).toEqual(expected);
  } finally {
    await fixture.dispose();
  }
});

test("Claude Code interruptSubagent sends stop_task for a live task only", async () => {
  const fixture = await controlledClaude();
  const { session, emit } = fixture;
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.sendMessage("wait");
    await emit({
      type: "system",
      subtype: "task_started",
      task_id: "task-live",
      tool_use_id: "toolu_live",
      description: "Watch the build",
      task_type: "local_bash",
      is_backgrounded: true,
    });
    const started = () =>
      events.some((event) => event.type === "subagent-progress" && event.phase === "started");
    for (let attempt = 0; attempt < 100 && !started(); attempt += 1) await Bun.sleep(5);
    expect(started()).toBe(true);
    // The fixture answers stop_task with the task's stopped notification.
    expect(await session.interruptSubagent!("task-live")).toBe("interrupted");
    const stopped = () =>
      events.some(
        (event) =>
          event.type === "subagent-progress" &&
          event.phase === "notification" &&
          event.taskStatus === "stopped",
      );
    for (let attempt = 0; attempt < 100 && !stopped(); attempt += 1) await Bun.sleep(5);
    expect(stopped()).toBe(true);
    // A task this session never tracked — or one already ended — is not running.
    expect(await session.interruptSubagent!("task-unknown")).toBe("not_running");
    expect(await session.interruptSubagent!("task-live")).toBe("not_running");
  } finally {
    await fixture.dispose();
  }
});

test("Claude Code's root/sudo refusal fails the launch naming the reason", async () => {
  // Raft's isClaudeRootRefusal: exit 1 with the exact stderr line before any turn.
  await expect(
    claudeFixtureProvider("root-refusal").createAgentSession({
      agentWorkspaceDirectory: tmpdir(),
      instructions: TEST_AGENT_INSTRUCTIONS,
    }),
  ).rejects.toThrow(
    "Claude Code cannot start with root or sudo privileges while permission checks are disabled",
  );
});

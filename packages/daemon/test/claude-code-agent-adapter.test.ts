import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ActivityTrajectory,
  TRAJECTORY_QUIET_WINDOW_MS,
} from "#src/agent-runtime/activity-trajectory";
import { ClaudeCodeProvider } from "#src/code-agent/claude-code/provider";
import {
  AGENT_RUNTIME_EVENT_TYPE,
  type AgentRuntimeEvent,
  type AgentSession,
  PROCESS_TREE_EXIT_GRACE_MS,
} from "@lrm/coforge-anvil";

import {
  backgroundBash,
  claudeFixtureProvider,
  controlledClaude,
  TEST_AGENT_INSTRUCTIONS,
  waitForEvent,
} from "./fixtures/claude-feed";

test.each(["missing-resume", "missing-before-initialize"])(
  "Claude %s closes before fresh launch and reports replacement without losing first input",
  async (mode) => {
    const reports: Array<[string, string | undefined]> = [];
    const confirmed = Promise.withResolvers<void>();
    const session = await claudeFixtureProvider(mode).createAgentSession({
      agentWorkspaceDirectory: tmpdir(),
      instructions: TEST_AGENT_INSTRUCTIONS,
      sessionId: "missing-session",
      async onSessionId(id, replaced) {
        reports.push([id, replaced]);
        if (reports.length === 2) confirmed.resolve();
      },
    });
    const completed = Promise.withResolvers<void>();
    let exits = 0;
    session.onExit(() => {
      exits++;
      completed.reject(new Error("unexpected terminal exit"));
    });
    session.subscribe((event) => {
      if (event.type === "completed") completed.resolve();
    });
    try {
      await session.sendMessage("finish");
      await completed.promise;
      await confirmed.promise;
      expect(reports).toHaveLength(2);
      expect(reports[0]?.[0]).toBe(reports[1]?.[0]);
      expect(reports[0]?.[0]).not.toBe("missing-session");
      expect(reports.map(([, replaced]) => replaced)).toEqual([
        "missing-session",
        "missing-session",
      ]);
      expect(exits).toBe(0);
    } finally {
      await session.dispose();
    }
  },
);

test.each([
  ["auth", ["resume-error", "Authentication failed"]],
  ["I/O", ["resume-error", "EACCES: permission denied"]],
  ["corruption", ["resume-error", "Invalid session transcript JSON"]],
  ["wrong ID", ["resume-error", "No conversation found with session ID: another-session"]],
  ["model progress", ["missing-resume", "progress-before-missing"]],
  ["validated identity", ["missing-resume", "init-before-missing"]],
  ["mixed errors", ["missing-resume", "mixed-error"]],
  ["invalid output", ["missing-resume", "invalid-output"]],
  ["failed fresh launch", ["missing-resume", "fresh-fails"]],
] as const)("Claude does not retry %s as missing history", async (name, args) => {
  const directory = await mkdtemp(join(tmpdir(), "claude-no-replay-"));
  const log = join(directory, "launches");
  const session = await claudeFixtureProvider(...args, "--launch-log", log).createAgentSession({
    agentWorkspaceDirectory: directory,
    instructions: TEST_AGENT_INSTRUCTIONS,
    sessionId: "missing-session",
  });
  const exited = Promise.withResolvers<void>();
  const events: AgentRuntimeEvent[] = [];
  session.onExit(() => exited.resolve());
  session.subscribe((event) => events.push(event));
  try {
    await session.sendMessage("finish");
    await exited.promise;
    expect(await readFile(log, "utf8")).toBe(
      name === "failed fresh launch" ? "resume\nfresh\n" : "resume\n",
    );
    expect(events.filter((event) => event.type === "completed")).toEqual([]);
    await expect(session.notify!("do not replay")).rejects.toThrow();
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude ends the tasks of a session it replaces with a fresh one", async () => {
  const session = await claudeFixtureProvider(
    "missing-resume",
    "task-before-missing",
  ).createAgentSession({
    agentWorkspaceDirectory: tmpdir(),
    instructions: TEST_AGENT_INSTRUCTIONS,
    sessionId: "missing-session",
  });
  const events: AgentRuntimeEvent[] = [];
  const completed = Promise.withResolvers<void>();
  session.subscribe((event) => {
    events.push(event);
    if (event.type === "completed") completed.resolve();
  });
  try {
    await session.sendMessage("finish");
    await completed.promise;
    // The old process's task never reports again, so the daemon must stop counting
    expect(
      events.flatMap((event) =>
        event.type === "subagent-progress" ? [[event.phase, event.taskId, event.taskStatus]] : [],
      ),
    ).toEqual([
      ["started", "task-lost", undefined],
      ["notification", "task-lost", "stopped"],
    ]);
  } finally {
    await session.dispose();
  }
});

test("Claude forwards cloud-selected persistent resume while retaining approved permissions", async () => {
  const provider = new ClaudeCodeProvider({
    command: [
      process.execPath,
      new URL("./fixtures/claude-stream-json.ts", import.meta.url).pathname,
      "expect-resume",
    ],
  });
  const session = await provider.createAgentSession({
    agentWorkspaceDirectory: tmpdir(),
    instructions: TEST_AGENT_INSTRUCTIONS,
    sessionId: "selected-session",
  });
  try {
    expect(session).toBeDefined();
  } finally {
    await session.dispose();
  }
});

test("Claude missing-session replacement retains notices until fresh turn boundary and dispose cancels them", async () => {
  const fixture = await controlledClaude("missing-session", undefined, "missing-resume");
  let accepted = 0;
  try {
    await fixture.session.sendMessage("wait");
    const notice = fixture.session.notify!("wait").then(() => {
      accepted++;
    });
    await toolBoundary(fixture.emit);
    expect(accepted).toBe(0);
    await fixture.emit({ type: "result", subtype: "success" });
    await notice;
    expect(accepted).toBe(1);
    const retained = Promise.allSettled([fixture.session.notify!("wait")]);
    await fixture.session.dispose();
    expect((await retained)[0]?.status).toBe("rejected");
  } finally {
    await fixture.dispose();
  }
});

test("Claude first input and turn boundary flow while late identity ACK is pending", async () => {
  const observed = Promise.withResolvers<void>();
  const ack = Promise.withResolvers<void>();
  const confirmed = Promise.withResolvers<void>();
  let reports = 0;
  let reportedSessionId: string | undefined;
  const session = await claudeFixtureProvider().createAgentSession({
    agentWorkspaceDirectory: tmpdir(),
    instructions: TEST_AGENT_INSTRUCTIONS,
    async onSessionId(id) {
      reportedSessionId ??= id;
      expect(id).toBe(reportedSessionId);
      reports++;
      observed.resolve();
      if (reports === 2) confirmed.resolve();
      await ack.promise;
    },
  });
  const complete = Promise.withResolvers<void>();
  session.subscribe((event) => {
    if (event.type === "completed") complete.resolve();
  });
  try {
    expect(reports).toBe(0);
    await session.sendMessage("finish");
    await observed.promise;
    await complete.promise;
    expect(reports).toBe(1);
    await session.notify!("wait");
    await session.interrupt();
    expect(reports).toBe(1);
    ack.resolve();
    await confirmed.promise;
    expect(reports).toBeGreaterThanOrEqual(2);
  } finally {
    ack.resolve();
    await session.dispose();
  }
});

test("Claude serializes duplicate init and turn-end identity observations without suppressing confirmation", async () => {
  const ack = Promise.withResolvers<void>();
  const confirmed = Promise.withResolvers<void>();
  const ids: string[] = [];
  const fixture = await controlledClaude(undefined, async (id) => {
    ids.push(id);
    if (ids.length === 3) confirmed.resolve();
    await ack.promise;
  });
  try {
    await fixture.session.sendMessage("wait");
    await fixture.emit(
      { type: "system", subtype: "init", session_id: fixture.sessionId },
      { type: "result", subtype: "success" },
    );
    expect(ids).toEqual([fixture.sessionId]);
    ack.resolve();
    await confirmed.promise;
    expect(ids).toEqual([fixture.sessionId, fixture.sessionId, fixture.sessionId]);
  } finally {
    ack.resolve();
    await fixture.dispose();
  }
});

test("Claude surfaces failed identity ACK and retries the observation at turn end", async () => {
  const failed = Promise.withResolvers<string>();
  const reported = Promise.withResolvers<void>();
  let attempts = 0;
  const fixture = await controlledClaude(undefined, async () => {
    if (++attempts === 1) throw new Error("identity ACK unavailable");
    reported.resolve();
  });
  fixture.session.subscribe((event) => {
    if (event.type === "error") failed.resolve(event.message);
  });
  try {
    await fixture.session.sendMessage("wait");
    expect(await failed.promise).toBe("identity ACK unavailable");
    await fixture.emit({ type: "result", subtype: "success" });
    await reported.promise;
    expect(attempts).toBe(2);
  } finally {
    await fixture.dispose();
  }
});

for (const [mode, sessionId] of [
  ["mismatched-init", "selected-session"],
  ["missing-init", "selected-session"],
  ["missing-init", undefined],
  ["invalid-init", undefined],
] as const) {
  test(`Claude terminates ${sessionId ? "resume" : "fresh session"} on ${mode} without accepting later success`, async () => {
    const reports: string[] = [];
    const session = await claudeFixtureProvider(mode).createAgentSession({
      agentWorkspaceDirectory: tmpdir(),
      instructions: TEST_AGENT_INSTRUCTIONS,
      sessionId,
      async onSessionId(id) {
        reports.push(id);
      },
    });
    const events: AgentRuntimeEvent[] = [];
    const exited = Promise.withResolvers<void>();
    session.onExit(() => exited.resolve());
    session.subscribe((event) => events.push(event));
    try {
      await session.sendMessage("finish");
      await exited.promise;
      expect(reports).toEqual([]);
      expect(events.filter((event) => event.type === "completed")).toEqual([]);
      await expect(session.notify!("not accepted")).rejects.toThrow();
    } finally {
      await session.dispose();
    }
  });
}

test("Claude Code initializes before the first prompt without waiting for turn metadata", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-code-"));
  const adapter = new ClaudeCodeProvider({
    command: [
      process.execPath,
      new URL("./fixtures/claude-stream-json.ts", import.meta.url).pathname,
    ],
  });

  try {
    const session = await adapter.createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
    });
    expect(session).toBeDefined();
    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Claude Code resolves a written notification without any input replay or run completion", async () => {
  const session = await claudeFixtureProvider().createAgentSession({
    agentWorkspaceDirectory: tmpdir(),
    instructions: TEST_AGENT_INSTRUCTIONS,
  });
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.notify!("wait");
    expect(events.filter((event) => event.type === "completed")).toEqual([]);
    await expect(session.sendMessage("overlap")).rejects.toThrow("already running");
  } finally {
    await session.dispose();
  }
});

test("Claude Code retains concurrent notices while initial session metadata is pending", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-starting-"));
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const gate = Bun.serve({
    port: 0,
    async fetch() {
      arrived.resolve();
      await release.promise;
      return new Response("ready");
    },
  });
  const session = await claudeFixtureProvider().createAgentSession({
    agentWorkspaceDirectory,
    instructions: TEST_AGENT_INSTRUCTIONS,
    environment: { COFORGE_CLAUDE_INIT_GATE: gate.url.href },
  });
  const metadataObserved = Promise.withResolvers<void>();
  session.subscribe((event) => {
    if (event.type === "text-delta" && event.text === "fixture-input-observed")
      metadataObserved.resolve();
  });
  try {
    const first = session.sendMessage("wait");
    await arrived.promise;
    let written = false;
    const notification = session.notify!("busy notice").then(() => {
      written = true;
    });
    await first;
    expect(written).toBe(false);
    release.resolve();
    await metadataObserved.promise;
    await session.interrupt();
    await notification;
    await expect(session.sendMessage("overlap")).rejects.toThrow("already running");
  } finally {
    release.resolve();
    await session.dispose();
    gate.stop(true);
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Claude Code rejects concurrent first notifications after process exit", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-input-exit-"));
  const session = await new ClaudeCodeProvider({
    command: [
      process.execPath,
      new URL("./fixtures/claude-stream-json.ts", import.meta.url).pathname,
      "exit-after-init",
    ],
  }).createAgentSession({
    agentWorkspaceDirectory,
    instructions: TEST_AGENT_INSTRUCTIONS,
  });
  try {
    await new Promise<void>((resolve) => session.onExit(resolve));
    const results = await Promise.allSettled([session.notify!("first"), session.notify!("second")]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  } finally {
    await session.dispose();
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Claude Code rejects a failed initialization handshake", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-init-rejected-"));
  try {
    await expect(
      new ClaudeCodeProvider({
        command: [
          process.execPath,
          new URL("./fixtures/claude-stream-json.ts", import.meta.url).pathname,
          "reject-initialize",
        ],
      }).createAgentSession({
        agentWorkspaceDirectory,
        instructions: TEST_AGENT_INSTRUCTIONS,
      }),
    ).rejects.toThrow("initialization was rejected");
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Claude Code starts the user's installed CLI from PATH in streaming mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-claude-installed-"));
  const agentWorkspaceDirectory = join(directory, "workspace");
  const binDirectory = join(directory, "bin");
  await mkdir(agentWorkspaceDirectory);
  await mkdir(binDirectory);
  const executable = join(binDirectory, "claude");
  await writeFile(
    executable,
    '#!/bin/sh\nprintf "%s" "$*" > "$COFORGE_CLAUDE_ARGS"\nexec "$COFORGE_BUN_EXEC" "$COFORGE_CLAUDE_FIXTURE" -- "$@"\n',
  );
  await chmod(executable, 0o755);
  const argumentsFile = join(directory, "claude-arguments");

  try {
    const session = await new ClaudeCodeProvider().createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
      runtime: {
        provider: "claude-code",
        model: "claude-sonnet-5",
        modelProvider: "",
        reasoning: "high",
      },
      environment: {
        PATH: binDirectory,
        COFORGE_BUN_EXEC: process.execPath,
        COFORGE_CLAUDE_FIXTURE: new URL("./fixtures/claude-stream-json.ts", import.meta.url)
          .pathname,
        COFORGE_CLAUDE_ARGS: argumentsFile,
      },
    });
    expect(await readFile(argumentsFile, "utf8")).toContain(
      "-p --input-format stream-json --output-format stream-json",
    );
    expect(await readFile(argumentsFile, "utf8")).toContain(
      "--model claude-sonnet-5 --effort high",
    );
    expect(await readFile(argumentsFile, "utf8")).toContain("--append-system-prompt-file");
    await session.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude Code maps stream-json turns behind the code-agent seam", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-events-"));
  const adapter = claudeFixtureProvider();

  try {
    const session = await adapter.createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.sendMessage("finish");
    await waitForEvent(events, "completed");
    // The partial delta only shows the turn is live; the text arrives once, from its block.
    const progress = {
      type: "progress" as const,
      source: "claude_stream_event",
      occurredAt: expect.any(String),
    };
    expect(events.filter((event) => event.type !== "session")).toEqual([
      progress,
      { type: "text-delta", text: "Claude response" },
      progress,
      {
        type: "tool-start",
        id: "tool-1",
        name: "Bash",
        input: { command: "printf safe" },
        occurredAt: "2026-01-02T03:04:05.000Z",
      },
      { type: "tool-output", id: "tool-1", text: "tests passed" },
      { type: "tool-end", id: "tool-1", isError: false },
      { type: "completed", status: "completed" },
    ]);
    expect(events.filter((event) => event.type === "session")).toEqual([
      { type: "session", identity: { sessionId: expect.any(String), state: "unknown" } },
      { type: "session", identity: { sessionId: expect.any(String), state: "empty" } },
      { type: "session", identity: { sessionId: expect.any(String), state: "resumable" } },
    ]);

    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Claude Code shows each completed text and thinking block as one Activity row", async () => {
  // Pauses longer than the trajectory's quiet window used to split a streamed block into rows.
  const fixture = await controlledClaude();
  const { session, emit } = fixture;
  const activities: AgentRuntimeEvent[] = [];
  const trajectory = new ActivityTrajectory((event) => {
    if (event.type === "activity") activities.push(event);
  });
  session.subscribe((event) => {
    if (event.type !== "text-delta" || event.text !== "fixture-input-observed")
      trajectory.accept(event);
  });
  const pause = () => Bun.sleep(TRAJECTORY_QUIET_WINDOW_MS + 50);
  const delta = (value: Record<string, unknown>) => ({
    type: "stream_event",
    event: { type: "content_block_delta", delta: value },
  });
  const stop = { type: "stream_event", event: { type: "content_block_stop" } };
  try {
    await session.sendMessage("wait");
    await emit(
      {
        type: "stream_event",
        event: { type: "content_block_start", content_block: { type: "thinking", thinking: "" } },
      },
      delta({ type: "thinking_delta", thinking: "Let me " }),
    );
    await pause();
    await emit(
      delta({ type: "thinking_delta", thinking: "think." }),
      {
        type: "assistant",
        message: { content: [{ type: "thinking", thinking: "Let me think." }] },
      },
      stop,
      {
        type: "stream_event",
        event: { type: "content_block_start", content_block: { type: "text", text: "" } },
      },
      delta({ type: "text_delta", text: "Hel" }),
    );
    await pause();
    await emit(
      delta({ type: "text_delta", text: "lo" }),
      { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
      stop,
      { type: "result", subtype: "success" },
    );
    expect(
      activities.map((event) =>
        event.type === "activity" ? [event.activity.detailKind, event.activity.entries] : [],
      ),
    ).toEqual([
      // Run-start markers still flip the status as soon as each block starts.
      ["thinking_started", undefined],
      ["thinking_started", [{ kind: "thinking", text: "Let me think." }]],
      ["thinking_end", undefined],
      ["model_response_started", undefined],
      ["model_response_started", [{ kind: "text", text: "Hello" }]],
    ]);
  } finally {
    trajectory.dispose();
    await fixture.dispose();
  }
});

test("Claude Code shows a completed text block that arrives without partial deltas", async () => {
  const fixture = await controlledClaude();
  const { session, emit } = fixture;
  const texts: AgentRuntimeEvent[] = [];
  session.subscribe((event) => {
    if (event.type === "text-delta" && event.text !== "fixture-input-observed") texts.push(event);
  });
  try {
    await session.sendMessage("wait");
    await emit({ type: "assistant", message: { content: [{ type: "text", text: "Only block" }] } });
    expect(texts).toEqual([{ type: "text-delta", text: "Only block" }]);
  } finally {
    await fixture.dispose();
  }
});

test("Claude Code reports a synthetic API-error message as one error before the failed turn", async () => {
  const fixture = await controlledClaude();
  const { session, emit } = fixture;
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => {
    if (event.type === "error" || event.type === "completed" || event.type === "text-delta")
      if (event.type !== "text-delta" || event.text !== "fixture-input-observed")
        events.push(event);
  });
  const message = "API Error: 529 Overloaded. The API is at capacity.";
  try {
    await session.sendMessage("wait");
    await emit(
      {
        type: "assistant",
        error: "overloaded",
        message: { content: [{ type: "text", text: message }] },
      },
      { type: "result", subtype: "success", is_error: true, result: message, errors: [] },
    );
    expect(events).toEqual([
      { type: "error", message, providerErrorCode: "overloaded", occurredAt: expect.any(String) },
      { type: "completed", status: "failed" },
    ]);
  } finally {
    await fixture.dispose();
  }
});

test("Claude Code exposes account rate-limit events as partial usage snapshots", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-usage-event-"));

  try {
    const session = await claudeFixtureProvider().createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.sendMessage("usage");
    await waitForEvent(events, "completed");
    expect(events.find((event) => event.type === AGENT_RUNTIME_EVENT_TYPE.USAGE)).toEqual({
      type: AGENT_RUNTIME_EVENT_TYPE.USAGE,
      snapshot: {
        provider: "claude-code",
        primary: {
          status: "limit_reached",
          windowDurationMinutes: 300,
          resetsAt: "2026-09-04T03:00:00.000Z",
        },
      },
    });

    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test(
  "Claude Code reports an API-error result as failed and accepts the next successful turn",
  async () => {
    const fixture = await controlledClaude();
    const { session, emit } = fixture;
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    try {
      await session.sendMessage("wait");
      await emit({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "API Error: Test authentication expired",
        errors: [],
      });
      expect(events.filter((event) => event.type === "completed")).toEqual([
        { type: "completed", status: "failed" },
      ]);
      expect(session.hasLiveTurn).toBe(false);

      events.length = 0;
      await session.sendMessage("wait");
      await emit({ type: "result", subtype: "success", is_error: false });
      expect(events.filter((event) => event.type === "completed")).toEqual([
        { type: "completed", status: "completed" },
      ]);
      expect(session.hasLiveTurn).toBe(false);
    } finally {
      await fixture.dispose();
    }
  },
  5_000 + 2 * PROCESS_TREE_EXIT_GRACE_MS,
);

test(
  "Claude Code rejects overlapping turns and interrupts an initialized CLI without replacing it",
  async () => {
    const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-lifecycle-"));
    const launchLog = join(agentWorkspaceDirectory, "launches");
    const adapter = claudeFixtureProvider("--launch-log", launchLog);
    const initRequested = Promise.withResolvers<void>();
    const releaseInit = Promise.withResolvers<void>();
    const initialized = Promise.withResolvers<void>();
    let gate: Bun.Server<undefined> | undefined;
    let session: AgentSession | undefined;

    try {
      gate = Bun.serve({
        port: 0,
        async fetch() {
          initRequested.resolve();
          await releaseInit.promise;
          return new Response("ready");
        },
      });
      session = await adapter.createAgentSession({
        agentWorkspaceDirectory,
        instructions: TEST_AGENT_INSTRUCTIONS,
        environment: { COFORGE_CLAUDE_INIT_GATE: gate.url.href },
        async onSessionId() {
          initialized.resolve();
        },
      });
      const events: AgentRuntimeEvent[] = [];
      let completion = Promise.withResolvers<void>();
      session.subscribe((event) => {
        events.push(event);
        if (event.type === "completed") completion.resolve();
      });

      await session.sendMessage("wait");
      await initRequested.promise;
      await expect(session.sendMessage("overlap")).rejects.toThrow("already running");
      releaseInit.resolve();
      await initialized.promise;
      await session.interrupt();
      await completion.promise;
      expect(events.at(-1)).toEqual({ type: "completed", status: "interrupted" });

      events.length = 0;
      completion = Promise.withResolvers<void>();
      await session.sendMessage("finish");
      await completion.promise;
      expect(events.at(-1)).toEqual({ type: "completed", status: "completed" });
      expect(await readFile(launchLog, "utf8")).toBe("fresh\n");
    } finally {
      releaseInit.resolve();
      try {
        await session?.dispose();
      } finally {
        gate?.stop(true);
        await rm(agentWorkspaceDirectory, { recursive: true, force: true });
      }
    }
  },
  5_000 + 2 * PROCESS_TREE_EXIT_GRACE_MS,
);

test("Claude Code accepts busy notifications in the existing session", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-notify-"));

  try {
    const session = await claudeFixtureProvider().createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.notify!("New message available. Run coforge message check.");
    await waitForEvent(events, "completed");
    expect(events.at(-1)).toEqual({ type: "completed", status: "completed" });

    await session.sendMessage("wait");
    events.length = 0;
    const notification = session.notify!("busy notice");
    await session.interrupt();
    await notification;
    expect(events.filter((event) => event.type === "completed")).toEqual([
      { type: "completed", status: "interrupted" },
    ]);
    await expect(session.sendMessage("overlap")).rejects.toThrow("already running");
    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Claude Code resolves a busy notification at the tool boundary without a replay", async () => {
  const fixture = await controlledClaude();
  const { session, emit } = fixture;
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => {
    events.push(event);
  });
  try {
    await session.sendMessage("wait");
    await emit({ type: "result", subtype: "success" });
    await session.sendMessage("wait");
    events.length = 0;
    let accepted = false;
    const notification = session.notify!("busy notice").then(() => {
      accepted = true;
    });
    void notification.catch(() => {});
    await emit({ type: "stream_event", event: { type: "message_stop" } });
    expect(accepted).toBe(false);
    await toolBoundary(emit);
    await notification;
    expect(accepted).toBe(true);
    expect(events.filter((event) => event.type === "completed")).toEqual([]);
  } finally {
    await fixture.dispose();
  }
});

test("Claude Code rejects interrupt when the CLI exits after SIGINT", async () => {
  const adapter = new ClaudeCodeProvider({
    command: [
      process.execPath,
      new URL("./fixtures/claude-stream-json.ts", import.meta.url).pathname,
      "exit-on-interrupt",
    ],
  });

  const session = await adapter.createAgentSession({
    agentWorkspaceDirectory: tmpdir(),
    instructions: TEST_AGENT_INSTRUCTIONS,
  });
  try {
    await session.sendMessage("wait");
    await expect(session.interrupt()).rejects.toThrow("exited unexpectedly");
  } finally {
    await session.dispose();
  }
});

test("Claude Code holds first-turn notifications until result, not text or tool completion", async () => {
  const fixture = await controlledClaude();
  const { session, emit } = fixture;
  try {
    await session.sendMessage("wait");
    let accepted = false;
    const notification = session.notify!("busy notice").then(() => {
      accepted = true;
    });
    await emit({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "first-tool", name: "Bash", input: {} }],
      },
    });
    await emit({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "first-tool", content: "done" }],
      },
    });
    expect(accepted).toBe(false);
    await emit({ type: "result", subtype: "success" });
    await notification;
    expect(accepted).toBe(true);
    await expect(session.sendMessage("overlap")).rejects.toThrow("already running");
  } finally {
    await fixture.dispose();
  }
});

test("Claude resumed identity accepts a tool boundary without a new first-turn result", async () => {
  const fixture = await controlledClaude("fixture-session");
  try {
    await fixture.session.sendMessage("wait");
    let written = false;
    const accepted = fixture.session.notify!("busy notice").then(() => {
      written = true;
    });
    void accepted.catch(() => {});
    await toolBoundary(fixture.emit);
    await accepted;
    expect(written).toBe(true);
  } finally {
    await fixture.dispose();
  }
});

test("Claude Code delivers at the complete tool batch in an established session", async () => {
  const fixture = await controlledClaude();
  const { session, emit } = fixture;
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.sendMessage("wait");
    await emit({ type: "result", subtype: "success" });
    await session.sendMessage("wait");
    events.length = 0;
    let accepted = false;
    const notification = session.notify!("busy notice").then(() => {
      accepted = true;
    });
    void notification.catch(() => {});
    await emit({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "a", name: "Bash", input: {} },
          { type: "tool_use", id: "b", name: "Bash", input: {} },
        ],
      },
    });
    await emit({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "a", content: "done" },
          {
            type: "tool_result",
            tool_use_id: "unknown",
            content: "irrelevant",
          },
        ],
      },
    });
    expect(accepted).toBe(false);
    await emit({
      type: "user",
      parent_tool_use_id: "child",
      message: {
        content: [{ type: "tool_result", tool_use_id: "b", content: "child output" }],
      },
    });
    expect(accepted).toBe(false);
    await emit({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "b", content: "done" }],
      },
    });
    await notification;
    expect(accepted).toBe(true);
    expect(events.filter((event) => event.type === "completed")).toEqual([]);
  } finally {
    await fixture.dispose();
  }
});

test("Claude Code retains notifications during compaction until the compact boundary", async () => {
  const fixture = await controlledClaude();
  const { session, emit } = fixture;
  try {
    await session.sendMessage("wait");
    await emit({ type: "result", subtype: "success" });
    await session.sendMessage("wait");
    await emit(
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "tool", name: "Bash", input: {} }],
        },
      },
      { type: "system", subtype: "status", status: "compacting" },
    );
    let accepted = false;
    const notification = session.notify!("busy notice").then(() => {
      accepted = true;
    });
    void notification.catch(() => {});
    await emit({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tool", content: "done" }],
      },
    });
    await emit({ type: "system", subtype: "status", status: null });
    expect(accepted).toBe(false);
    await emit({ type: "system", subtype: "compact_boundary" });
    await notification;
    expect(accepted).toBe(true);
  } finally {
    await fixture.dispose();
  }
});

test("Claude Code reports a compaction-started event per status=compacting line, and compaction-finished at the boundary", async () => {
  // The adapter relays the raw signal as-is; de-duping repeated "compacting" lines into a
  // single reported episode is the daemon core's job now (agent-runtime/phase-tracker.ts,
  // exercised in activity-heartbeat.test.ts), not the adapter's.
  const fixture = await controlledClaude();
  const { session, emit } = fixture;
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.sendMessage("wait");
    await emit(
      { type: "system", subtype: "status", status: "compacting" },
      { type: "system", subtype: "status", status: "compacting" },
    );
    await waitForEvent(events, "compaction-started");
    await emit({ type: "system", subtype: "compact_boundary" });
    await waitForEvent(events, "compaction-finished");
    expect(events.filter((event) => event.type === "compaction-started")).toHaveLength(2);
    expect(events.filter((event) => event.type === "compaction-finished")).toHaveLength(1);
  } finally {
    await fixture.dispose();
  }
});

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
    expect(
      events.flatMap((event) =>
        event.type === "subagent-progress"
          ? [
              {
                phase: event.phase,
                taskId: event.taskId,
                type: event.subagentType,
                parent: event.parentToolUseId,
                status: event.taskStatus,
              },
            ]
          : [],
      ),
    ).toEqual([
      ...(["started", "progress"] as const).map((phase) => ({
        phase,
        taskId: "task-agent",
        type: "general-purpose",
        parent: "toolu_agent",
        status: undefined,
      })),
      // A background command is a task too, with its rows, as in the reference client.
      {
        phase: "started",
        taskId: "task-bash",
        type: undefined,
        parent: "toolu_bash",
        status: undefined,
      },
      {
        phase: "notification",
        taskId: "task-bash",
        type: undefined,
        parent: "toolu_bash",
        status: "completed",
      },
      {
        phase: "notification",
        taskId: "task-agent",
        type: "general-purpose",
        parent: "toolu_agent",
        status: "completed",
      },
    ]);
  } finally {
    await fixture.dispose();
  }
});

test("Claude Code reports compaction-finished on compact_boundary even without an open compaction", async () => {
  // Whether an unmatched finish is visible is the daemon core's guard now (dedup lives there),
  // not the adapter's - the adapter always relays the raw boundary signal.
  const fixture = await controlledClaude();
  const { session, emit } = fixture;
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.sendMessage("wait");
    await emit({ type: "system", subtype: "compact_boundary" });
    await waitForEvent(events, "compaction-finished");
    expect(events.filter((event) => event.type === "compaction-started")).toHaveLength(0);
  } finally {
    await fixture.dispose();
  }
});

// "Thinking finished" is derived centrally by ActivityTrajectory from the normalized event
// stream (packages/daemon/test/activity-trajectory.test.ts), not reported by this provider.
// A closing thinking content block therefore just falls through to the same content-free
// liveness ping any other partial stream event gets.
test("Claude Code reports a liveness ping, not thinking_end, when a thinking content block closes", async () => {
  const fixture = await controlledClaude();
  const { session, emit } = fixture;
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.sendMessage("wait");
    await emit(
      {
        type: "stream_event",
        event: { type: "content_block_start", content_block: { type: "thinking", thinking: "" } },
      },
      { type: "stream_event", event: { type: "content_block_stop" } },
    );
    await waitForEvent(events, "progress");
    const kinds = events
      .filter((event) => event.type === "activity")
      .map((event) => event.activity.detailKind);
    expect(kinds).not.toContain("thinking_end");
  } finally {
    await fixture.dispose();
  }
});

test("Claude Code does not report thinking_end for a content block stop without an open thinking block", async () => {
  const fixture = await controlledClaude();
  const { session, emit } = fixture;
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.sendMessage("wait");
    await emit(
      {
        type: "stream_event",
        event: { type: "content_block_start", content_block: { type: "text", text: "" } },
      },
      { type: "stream_event", event: { type: "content_block_stop" } },
    );
    await emit({ type: "stream_event", event: { type: "message_stop" } });
    const kinds = events
      .filter((event) => event.type === "activity")
      .map((event) => event.activity.detailKind);
    expect(kinds).not.toContain("thinking_end");
    expect(events.some((event) => event.type === "progress")).toBe(true);
  } finally {
    await fixture.dispose();
  }
});

test("Claude Code reports a raw error event, not a classified activity, when the CLI exits unexpectedly", async () => {
  // The provider reports the raw fact only; the daemon core (agent-runtime/
  // runtime-error-activity.ts) is the single place that turns it into a
  // visible runtime_error/runtime_crashed Activity.
  const adapter = new ClaudeCodeProvider({
    command: [
      process.execPath,
      new URL("./fixtures/claude-stream-json.ts", import.meta.url).pathname,
      "exit-on-interrupt",
    ],
  });
  const session = await adapter.createAgentSession({
    agentWorkspaceDirectory: tmpdir(),
    instructions: TEST_AGENT_INSTRUCTIONS,
  });
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.sendMessage("wait");
    await session.interrupt().catch(() => {});
    await waitForEvent(events, "error");
    const error = events.find((event) => event.type === "error");
    expect(error).toMatchObject({
      type: "error",
      message: "code agent process exited unexpectedly",
    });
    expect(
      events.some(
        (event) =>
          event.type === "activity" &&
          (event.activity.detailKind === "runtime_crashed" ||
            event.activity.detailKind === "runtime_error"),
      ),
    ).toBe(false);
  } finally {
    await session.dispose();
  }
});

test("Claude Code holds later text-only turns and delivers all waiting notices once", async () => {
  const fixture = await controlledClaude();
  const { session, emit, inputsRead } = fixture;
  try {
    await session.sendMessage("wait");
    await emit({ type: "result", subtype: "success" });
    await session.sendMessage("wait");
    let accepted = 0;
    const first = session.notify!("first busy notice").then(() => {
      accepted++;
    });
    const second = session.notify!("second busy notice").then(() => {
      accepted++;
    });
    void first.catch(() => {});
    void second.catch(() => {});
    await emit({
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: { type: "thinking", thinking: "" },
      },
    });
    await emit(
      { type: "stream_event", event: { type: "message_stop" } },
      { type: "result", parent_tool_use_id: "child", subtype: "success" },
    );
    expect(accepted).toBe(0);
    await emit({ type: "result", subtype: "success" });
    await Promise.all([first, second]);
    expect(accepted).toBe(2);
    // Accepted is written, not read. Claude Code reads both notices before it ends their turn; a
    // fixture answer read after that result would start one more turn.
    await inputsRead(4);
    await emit({ type: "result", subtype: "success" });
    await session.sendMessage("wait");
    expect(accepted).toBe(2);
  } finally {
    await fixture.dispose();
  }
});

test("Claude Code ignores late user echoes after a completed turn", async () => {
  const fixture = await controlledClaude();
  const { session, emit } = fixture;
  const completions: AgentRuntimeEvent[] = [];
  session.subscribe((event) => {
    if (event.type === "completed") completions.push(event);
  });
  try {
    await session.sendMessage("wait");
    await emit({ type: "result", subtype: "success" });
    expect(completions).toHaveLength(1);
    await emit({
      type: "user",
      uuid: "late-echo",
      message: { role: "user", content: "wait" },
    });
    await emit({ type: "result", subtype: "success" });
    expect(completions).toHaveLength(1);
    await session.sendMessage("wait");
  } finally {
    await fixture.dispose();
  }
});

test(
  "Claude late tool and message events cannot restart a completed turn",
  async () => {
    const fixture = await controlledClaude();
    const { session, emit } = fixture;
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.sendMessage("wait");
      await emit({ type: "result", subtype: "success" });
      events.length = 0;
      await emit(
        {
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "late-tool", content: "late output" }],
          },
        },
        { type: "stream_event", event: { type: "message_start" } },
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "late-tool", name: "Bash", input: {} }] },
        },
      );
      expect(events.filter((event) => event.type !== "usage")).toEqual([]);
      await session.sendMessage("wait");
    } finally {
      await fixture.dispose();
    }
  },
  5_000 + 2 * PROCESS_TREE_EXIT_GRACE_MS,
);

test(
  "Claude reports a turn it starts by itself for a finished background task, from its init to its result",
  async () => {
    // Shaped like Claude Code 2.1.304 stream-json (observed 2026-10-20): after the session's
    // result, a background task's notification makes Claude Code open a turn of its own, which
    // starts with a top-level `init` for the same session and whose `result` names its origin.
    const fixture = await controlledClaude();
    const { session, emit } = fixture;
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    const shown = () =>
      events.flatMap((event) => {
        if (event.type === "text-delta" && event.text !== "fixture-input-observed")
          return [`text: ${event.text}`];
        if (event.type === "tool-start") return [`tool-start: ${event.name}`];
        if (event.type === "tool-end") return [`tool-end: ${event.id}`];
        if (event.type === "subagent-progress") return [`task ${event.phase}: ${event.taskId}`];
        if (event.type === "completed") return [`completed: ${event.status}`];
        return [];
      });
    try {
      await session.sendMessage("wait");
      await emit({ type: "result", subtype: "success" });
      expect(session.hasLiveTurn).toBe(false);
      events.length = 0;
      await emit({ type: "system", subtype: "init", session_id: fixture.sessionId });
      expect(session.hasLiveTurn).toBe(true);
      await emit(
        { type: "system", subtype: "status", status: "requesting" },
        { type: "stream_event", event: { type: "message_start" }, parent_tool_use_id: null },
        {
          type: "assistant",
          parent_tool_use_id: null,
          message: { content: [{ type: "text", text: "The task printed done." }] },
        },
        ...backgroundBash("next"),
      );
      expect(session.hasLiveTurn).toBe(true);
      await emit({
        type: "result",
        subtype: "success",
        is_error: false,
        origin: { kind: "task-notification", producer: "session-task", runId: "run-previous" },
      });
      expect(session.hasLiveTurn).toBe(false);
      expect(shown()).toEqual([
        "text: The task printed done.",
        "tool-start: Bash",
        "task started: task-next",
        "tool-end: toolu_next",
        "completed: completed",
      ]);
      // The turn ended like any other: CoForge can start the next one.
      await session.sendMessage("wait");
      expect(session.hasLiveTurn).toBe(true);
    } finally {
      await fixture.dispose();
    }
  },
  5_000 + 2 * PROCESS_TREE_EXIT_GRACE_MS,
);

test(
  "Claude opens no turn for an idle init that names another session, and ends the session",
  async () => {
    // Pins behavior that predates self-started turns: a foreign session's init still ends it.
    const fixture = await controlledClaude();
    const { session, emit } = fixture;
    const events: AgentRuntimeEvent[] = [];
    const exited = Promise.withResolvers<void>();
    session.onExit(() => exited.resolve());
    session.subscribe((event) => events.push(event));
    try {
      await session.sendMessage("wait");
      await emit({ type: "result", subtype: "success" });
      events.length = 0;
      // The session ends at this init, so it never reads a marker after these records.
      fixture.write(
        { type: "system", subtype: "init", session_id: "another-session" },
        { type: "stream_event", event: { type: "message_start" } },
        { type: "assistant", message: { content: [{ type: "text", text: "Not this session." }] } },
        { type: "result", subtype: "success" },
      );
      await exited.promise;
      expect(session.hasLiveTurn).toBe(false);
      expect(events.map((event) => event.type)).toEqual(["error"]);
      expect(events[0]).toMatchObject({
        message: "Claude did not establish a valid session identity",
      });
    } finally {
      await fixture.dispose();
    }
  },
  5_000 + 2 * PROCESS_TREE_EXIT_GRACE_MS,
);

test(
  "Claude opens no turn for an idle init of its session before any turn has ended",
  async () => {
    const fixture = await controlledClaude(undefined, undefined, "feed-before-input");
    const { session } = fixture;
    try {
      await fixture.emitBeforeInput({
        type: "system",
        subtype: "init",
        session_id: fixture.sessionId,
      });
      expect(session.hasLiveTurn).toBe(false);
      await session.sendMessage("wait");
      expect(session.hasLiveTurn).toBe(true);
    } finally {
      await fixture.dispose();
    }
  },
  5_000 + 2 * PROCESS_TREE_EXIT_GRACE_MS,
);

test("Claude Code observes the next native turn after a busy notification was written", async () => {
  const fixture = await controlledClaude();
  const { session, emit } = fixture;
  const completions: AgentRuntimeEvent[] = [];
  session.subscribe((event) => {
    if (event.type === "completed") completions.push(event);
  });
  try {
    await session.sendMessage("wait");
    await emit({ type: "result", subtype: "success" });
    await session.sendMessage("wait");
    const written = session.notify!("busy notice");
    await toolBoundary(emit);
    await written;
    await emit({ type: "result", subtype: "success" });
    expect(completions).toHaveLength(2);
    await emit({ type: "stream_event", event: { type: "message_start" } });
    await expect(session.sendMessage("overlap")).rejects.toThrow("already running");
    await emit({ type: "result", subtype: "success" });
    expect(completions).toHaveLength(3);
  } finally {
    await fixture.dispose();
  }
});

for (const terminal of ["dispose", "exit"] as const) {
  test(`Claude Code rejects retained notices on ${terminal} without completing the active turn`, async () => {
    const session = await claudeFixtureProvider("exit-on-interrupt").createAgentSession({
      agentWorkspaceDirectory: tmpdir(),
      instructions: TEST_AGENT_INSTRUCTIONS,
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.sendMessage("wait");
      const pending = Promise.allSettled([session.notify!("one"), session.notify!("two")]);
      if (terminal === "dispose") await session.dispose();
      else await expect(session.interrupt()).rejects.toThrow();
      expect((await pending).map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(events.filter((event) => event.type === "completed")).toEqual([]);
      await expect(session.notify!("after termination")).rejects.toThrow();
    } finally {
      await session.dispose();
    }
  });
}

async function toolBoundary(emit: (...records: Record<string, unknown>[]) => Promise<void>) {
  await emit(
    {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "boundary-tool", name: "Bash", input: {} }],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "boundary-tool",
            content: "done",
          },
        ],
      },
    },
  );
}

test("Claude reports raw tool-start events, leaving activity resolution to the daemon core", async () => {
  const fixture = await controlledClaude();
  const toolStarts: AgentRuntimeEvent[] = [];
  fixture.session.subscribe((event) => {
    if (event.type === "tool-start") toolStarts.push(event);
  });
  try {
    await fixture.session.sendMessage("wait");
    await fixture.emit({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "alias-read",
            name: "ReadFile",
            input: { path: "src/read.ts" },
          },
          {
            type: "tool_use",
            id: "alias-edit",
            name: "apply_patch",
            input: { path: "src/edit.ts", patch: "private patch contents" },
          },
          {
            type: "tool_use",
            id: "alias-other",
            name: "CustomTool",
            input: { prompt: "private prompt" },
          },
        ],
      },
    });
    expect(toolStarts).toMatchObject([
      {
        type: "tool-start",
        id: "alias-read",
        name: "ReadFile",
        input: { path: "src/read.ts" },
      },
      {
        type: "tool-start",
        id: "alias-edit",
        name: "apply_patch",
        input: { path: "src/edit.ts", patch: "private patch contents" },
      },
      {
        type: "tool-start",
        id: "alias-other",
        name: "CustomTool",
        input: { prompt: "private prompt" },
      },
    ]);
  } finally {
    await fixture.dispose();
  }
});

test("Claude tags a subagent's tool-start with its parent_tool_use_id", async () => {
  const fixture = await controlledClaude();
  const toolStarts: AgentRuntimeEvent[] = [];
  fixture.session.subscribe((event) => {
    if (event.type === "tool-start") toolStarts.push(event);
  });
  try {
    await fixture.session.sendMessage("wait");
    await fixture.emit({
      type: "assistant",
      parent_tool_use_id: "parent-1",
      message: {
        content: [{ type: "tool_use", id: "child-tool", name: "Bash", input: { command: "ls" } }],
      },
    });
    expect(toolStarts).toMatchObject([
      {
        type: "tool-start",
        id: "child-tool",
        name: "Bash",
        input: { command: "ls" },
        subagent: { parentToolUseId: "parent-1" },
      },
    ]);
  } finally {
    await fixture.dispose();
  }
});

test("Claude names a subagent's type on its lineage, from the Agent call that started it", async () => {
  const fixture = await controlledClaude();
  const scoped: AgentRuntimeEvent[] = [];
  const lineages: unknown[] = [];
  fixture.session.subscribe((event) => {
    if ((event.type === "tool-start" || event.type === "text-delta") && event.subagent) {
      scoped.push(event);
      lineages.push(event.subagent);
    }
  });
  try {
    await fixture.session.sendMessage("wait");
    await fixture.emit(
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_agent",
              name: "Agent",
              input: { subagent_type: "Explore", description: "Find it", prompt: "private" },
            },
          ],
        },
      },
      {
        type: "assistant",
        parent_tool_use_id: "toolu_agent",
        message: {
          content: [
            { type: "text", text: "Looking" },
            { type: "tool_use", id: "child-1", name: "Read", input: { file_path: "a" } },
          ],
        },
      },
    );
    await waitForEvent(scoped, "tool-start");
    expect(lineages).toEqual([
      { parentToolUseId: "toolu_agent", subagentType: "Explore" },
      { parentToolUseId: "toolu_agent", subagentType: "Explore" },
    ]);
  } finally {
    await fixture.dispose();
  }
});

test("Claude names a subagent's type from its own record, or from task_started, else leaves it out", async () => {
  // Claude Code 2.1.303 stamps a subagent's assistant records with `subagent_type`;
  // `task_started` names the type of the tool call it belongs to.
  const fixture = await controlledClaude();
  const toolStarts: AgentRuntimeEvent[] = [];
  fixture.session.subscribe((event) => {
    if (event.type === "tool-start") toolStarts.push(event);
  });
  const childCall = (parent: string, id: string, extra: Record<string, unknown> = {}) => ({
    type: "assistant",
    parent_tool_use_id: parent,
    ...extra,
    message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }] },
  });
  try {
    await fixture.session.sendMessage("wait");
    await fixture.emit(
      childCall("toolu_a", "child-a", { subagent_type: "Plan" }),
      {
        type: "system",
        subtype: "task_started",
        task_id: "task-b",
        tool_use_id: "toolu_b",
        subagent_type: "general-purpose",
        task_type: "local_agent",
      },
      childCall("toolu_b", "child-b"),
      childCall("toolu_c", "child-c"),
    );
    await Bun.sleep(20);
    expect(toolStarts.map((event) => event.type === "tool-start" && event.subagent)).toEqual([
      { parentToolUseId: "toolu_a", subagentType: "Plan" },
      { parentToolUseId: "toolu_b", subagentType: "general-purpose" },
      { parentToolUseId: "toolu_c" },
    ]);
  } finally {
    await fixture.dispose();
  }
});

test("Claude makes a subagent's type single-line and capped where its lineage is made, or leaves it out", async () => {
  const fixture = await controlledClaude();
  const lineages: unknown[] = [];
  fixture.session.subscribe((event) => {
    if (event.type === "tool-start" && event.subagent) lineages.push(event.subagent);
  });
  const agentCall = (id: string, subagentType: string) => ({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      content: [{ type: "tool_use", id, name: "Agent", input: { subagent_type: subagentType } }],
    },
  });
  const childCall = (parent: string, extra: Record<string, unknown> = {}) => ({
    type: "assistant",
    parent_tool_use_id: parent,
    ...extra,
    message: { content: [{ type: "tool_use", id: `${parent}-child`, name: "Bash", input: {} }] },
  });
  try {
    await fixture.session.sendMessage("wait");
    await fixture.emit(
      childCall("toolu_a", { subagent_type: " Explore\n  agent " }),
      agentCall("toolu_b", "x".repeat(60)),
      childCall("toolu_b"),
      agentCall("toolu_c", "\x07 \n"),
      childCall("toolu_c"),
    );
    await Bun.sleep(20);
    expect(lineages).toEqual([
      { parentToolUseId: "toolu_a", subagentType: "Explore agent" },
      { parentToolUseId: "toolu_b", subagentType: `${"x".repeat(39)}…` },
      { parentToolUseId: "toolu_c" },
    ]);
  } finally {
    await fixture.dispose();
  }
});

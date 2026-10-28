import { expect, test } from "bun:test";
import type { AgentRuntimeEvent, AgentSession, AgentSessionOptions } from "@coforge/agent";
import { TaskExecutionSessions } from "#src/agent-runtime/task-execution-sessions";

function fixture(
  failRunningReport = false,
  bindingWrite?: () => Promise<void>,
  disposeNative?: (options: AgentSessionOptions) => Promise<void>,
) {
  const calls: {
    options: AgentSessionOptions;
    messages: string[];
    finish(): void;
    emit(event: AgentRuntimeEvent): void;
    interrupts: number;
  }[] = [];
  const records = new Map();
  const bindings = new Map();
  const reports: unknown[] = [];
  const deliveries = new Map<string, PromiseWithResolvers<void>>();
  const delivery = (target: string) => {
    let value = deliveries.get(target);
    if (!value) {
      value = Promise.withResolvers<void>();
      deliveries.set(target, value);
    }
    return value;
  };
  const create = async (options: AgentSessionOptions): Promise<AgentSession> => {
    const listeners = new Set<(event: AgentRuntimeEvent) => void>();
    let busy = false;
    const messages: string[] = [];
    calls.push({
      options,
      messages,
      interrupts: 0,
      emit(event) {
        for (const listener of listeners) listener(event);
      },
      finish() {
        busy = false;
        for (const listener of listeners) listener({ type: "completed", status: "completed" });
      },
    });
    return {
      get hasLiveTurn() {
        return busy;
      },
      async sendMessage(text) {
        busy = true;
        messages.push(text);
      },
      async notify(text) {
        busy = true;
        messages.push(text);
        if (options.conversation) delivery(options.conversation.target).resolve();
      },
      async readSessionIdentity() {
        return { sessionId: options.sessionId!, state: "resumable" };
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onExit() {
        return () => {};
      },
      async interrupt() {
        const call = calls.find((value) => value.options === options)!;
        call.interrupts++;
        call.finish();
      },
      async dispose() {
        await disposeNative?.(options);
        busy = false;
      },
    };
  };
  const options: AgentSessionOptions = {
    agentId: "agent",
    agentWorkspaceDirectory: "/workspace",
    instructions: "Stable instructions",
    sessionId: "standing-session",
    sessionMode: "resume",
  };
  const open = async () =>
    TaskExecutionSessions.open({
      primary: await create(options),
      options,
      create,
      store: {
        async get(control, key) {
          return records.get(`${control}:${key}`);
        },
        async set(control, key, value) {
          records.set(`${control}:${key}`, value);
        },
      },
      bindings: {
        async read(control) {
          return bindings.get(control) ?? [];
        },
        async write(control, value) {
          await bindingWrite?.();
          bindings.set(control, value);
        },
      },
      async report(task, status, nativeSessionId) {
        reports.push({ task, status, nativeSessionId });
        if (failRunningReport && status === "running")
          throw new Error("Report transport unavailable");
      },
    });
  const task = (number: number) => ({
    executionSessionId: `execution-${number}`,
    attempt: 1,
    conversationId: "channel",
    messageId: `root-${number}`,
    number,
    title: `Task ${number}`,
    description: "Acceptance evidence",
    revision: 1,
    target: `#project:root-${number}`,
  });
  return { open, task, calls, reports, delivered: (target: string) => delivery(target).promise };
}

test("a claim hands off after the standing turn and each task has its own native history", async () => {
  const f = fixture();
  const session = await f.open();
  try {
    await session.sendMessage("ordinary chat");
    await session.handoffTask!(f.task(1));
    expect(f.calls[0]!.messages).toEqual(["ordinary chat"]);
    f.calls[0]!.finish();
    await f.delivered(f.task(1).target);
    expect(f.calls[1]!.options.sessionId).not.toBe("standing-session");
    expect(f.calls[1]!.options.instructions).toContain("Task 1");
    expect(f.calls[1]!.options.instructions).not.toContain("Task 7");
    f.calls[1]!.finish();
    await session.handoffTask!(f.task(7));
    await f.delivered(f.task(7).target);
    expect(f.calls[2]!.options.sessionId).not.toBe(f.calls[1]!.options.sessionId);
    expect(f.calls[2]!.options.instructions).toContain("Task 7");
    f.calls[2]!.finish();
    await session.notify!("updated requirement", {
      conversation: { conversationId: "channel", target: f.task(1).target },
    });
    expect(f.calls[1]!.messages.at(-1)).toBe("updated requirement");
    expect(f.calls[2]!.messages).not.toContain("updated requirement");
    expect(await session.readSessionIdentity!()).toEqual({
      sessionId: "standing-session",
      state: "resumable",
    });
  } finally {
    await session.dispose();
  }
});

test("restart restores task bindings and histories without replaying an external job", async () => {
  const f = fixture();
  let session = await f.open();
  try {
    await session.handoffTask!(f.task(1));
    await f.delivered(f.task(1).target);
    const nativeId = f.calls[1]!.options.sessionId;
    f.calls[1]!.finish();
    await session.dispose();
    session = await f.open();
    await session.notify!("job completed", {
      conversation: { conversationId: "channel", target: "#renamed:root-1" },
    });
    expect(f.calls.at(-1)!.options.sessionId).toBe(nativeId);
    expect(f.calls.at(-1)!.options.sessionMode).toBe("resume");
    expect(f.calls.at(-1)!.messages).toEqual(["job completed"]);
  } finally {
    await session.dispose();
  }
});

test("repeated claim receipts do not enqueue another execution", async () => {
  const f = fixture();
  const session = await f.open();
  try {
    await session.handoffTask!(f.task(1));
    await f.delivered(f.task(1).target);
    await session.handoffTask!(f.task(1));
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.messages).toHaveLength(1);
  } finally {
    await session.dispose();
  }
});

test("an ended task releases the workspace and a stale terminal signal cannot end another attempt", async () => {
  const f = fixture();
  const session = await f.open();
  try {
    await session.handoffTask!(f.task(1));
    await f.delivered(f.task(1).target);
    await session.endTask!(f.task(1).executionSessionId, 9);
    const second = session.handoffTask!(f.task(7));
    await second;
    await session.endTask!(f.task(1).executionSessionId, 1);
    await f.delivered(f.task(7).target);
    expect(f.calls.at(-1)!.options.instructions).toContain("Task 7");
  } finally {
    await session.dispose();
  }
});

test("handoff ends the standing turn after its tool receipt without interrupting another open tool", async () => {
  const f = fixture();
  const session = await f.open();
  try {
    await session.sendMessage("claim request");
    f.calls[0]!.emit({ type: "tool-start", id: "claim", name: "shell" });
    f.calls[0]!.emit({ type: "tool-start", id: "other", name: "shell" });
    await session.handoffTask!(f.task(7));
    f.calls[0]!.emit({ type: "tool-end", id: "claim", isError: false });
    expect(f.calls[0]!.interrupts).toBe(0);
    f.calls[0]!.emit({ type: "tool-end", id: "other", isError: false });
    await f.delivered(f.task(7).target);
    expect(f.calls[0]!.interrupts).toBe(1);
  } finally {
    await session.dispose();
  }
});

test("an accepted native input is not marked failed merely because its running report fails", async () => {
  const f = fixture(true);
  const session = await f.open();
  try {
    await session.handoffTask!(f.task(7));
    await f.delivered(f.task(7).target);
  } finally {
    await session.dispose();
  }
  expect(f.reports.some((report) => (report as { status: string }).status === "failed")).toBe(
    false,
  );
});

test("stopping a queued task preserves recovery without recording an execution failure", async () => {
  const f = fixture();
  const session = await f.open();
  await session.sendMessage("standing turn");
  await session.handoffTask!(f.task(7));
  session.cancelPendingNotices();
  await session.dispose();
  expect(f.calls).toHaveLength(2);
  expect(f.calls[1]!.messages).toEqual([]);
  expect(f.reports.some((report) => (report as { status: string }).status === "failed")).toBe(
    false,
  );
});

test("an end signal racing a persisted handoff cannot start work in standing chat", async () => {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const f = fixture(false, () => {
    entered.resolve();
    return gate.promise;
  });
  const session = await f.open();
  const handoff = session.handoffTask!(f.task(7));
  try {
    await entered.promise;
    const ended = session.endTask!(f.task(7).executionSessionId, 1);
    gate.resolve();
    await Promise.all([handoff, ended]);
  } finally {
    gate.resolve();
    await session.dispose();
  }
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.messages).toEqual([]);
});

test("ending an old attempt cannot erase a retry bound while native cleanup waits", async () => {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let oldNative: string | undefined;
  const f = fixture(false, undefined, async (options) => {
    if (options.sessionId === oldNative) {
      entered.resolve();
      await gate.promise;
    }
  });
  const session = await f.open();
  const task = f.task(7);
  try {
    await session.handoffTask!(task);
    await f.delivered(task.target);
    oldNative = f.calls[1]!.options.sessionId;
    const ended = session.endTask!(task.executionSessionId, 1);
    await entered.promise;
    const handoff = session.handoffTask!({ ...task, executionSessionId: "retry-7", attempt: 2 });
    gate.resolve();
    await Promise.all([ended, handoff]);
    await session.notify!("retry evidence", {
      conversation: { conversationId: task.conversationId, target: task.target },
    });
    expect(f.calls[0]!.messages).toEqual([]);
    expect(f.calls.at(-1)!.messages).toContain("retry evidence");
  } finally {
    gate.resolve();
    await session.dispose();
  }
});

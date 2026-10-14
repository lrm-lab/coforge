import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRuntimeEvent, AgentSession, AgentSessionOptions } from "@coforge/agent";
import { MemoryConversationSessions } from "#src/agent-runtime/memory-conversation-sessions";
import { FileConversationSessionStore } from "#src/persistence/conversation-session-store";

const a = { conversationId: "11111111-1111-4111-8111-111111111111", target: "#alpha" };
const b = { conversationId: "22222222-2222-4222-8222-222222222222", target: "#beta" };

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "memory-conversation-sessions-"));
  directories.push(directory);
  const work = join(directory, "workspace");
  const calls: {
    options: AgentSessionOptions;
    messages: string[];
    session: AgentSession;
    emit(event: AgentRuntimeEvent): void;
  }[] = [];
  let counter = 0;
  const create = async (options: AgentSessionOptions): Promise<AgentSession> => {
    const listeners = new Set<(event: AgentRuntimeEvent) => void>();
    const exits = new Set<() => void>();
    const messages: string[] = [];
    const id = options.sessionId ?? `native-${++counter}`;
    const session: AgentSession = {
      hasLiveTurn: false,
      async sendMessage(message) {
        messages.push(message);
      },
      async notify(message) {
        messages.push(message);
        for (const receive of listeners) receive({ type: "text-delta", text: message });
      },
      async readSessionIdentity() {
        return { sessionId: id, state: "resumable" };
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onExit(listener) {
        exits.add(listener);
        return () => exits.delete(listener);
      },
      async interrupt() {},
      async dispose() {
        for (const exit of exits) exit();
      },
    };
    await options.onSessionId?.(id);
    calls.push({
      options,
      messages,
      session,
      emit(event) {
        for (const listener of listeners) listener(event);
      },
    });
    return session;
  };
  const options: AgentSessionOptions = {
    agentId: "memory",
    agentWorkspaceDirectory: work,
    instructions: "Memory instructions",
    sessionId: "control-session",
    sessionMode: "resume",
  };
  const open = async (controlId = options.sessionId) =>
    new MemoryConversationSessions({
      primary: await create({ ...options, sessionId: controlId }),
      options: { ...options, sessionId: controlId },
      create,
      store: new FileConversationSessionStore(join(directory, "state.json")),
    });
  return { directory, work, calls, open };
}

test("each conversation has a distinct history and trajectory with one shared work directory", async () => {
  const f = await fixture();
  const session = await f.open();
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.notify!("alpha secret", { conversation: a });
    await session.notify!("beta question", { conversation: b });
    await session.notify!("alpha again", { conversation: { ...a, target: "#alpha/thread:root" } });
    expect(f.calls).toHaveLength(3);
    expect(f.calls[1]!.messages).toEqual(["alpha secret", "alpha again"]);
    expect(f.calls[2]!.messages).toEqual(["beta question"]);
    expect(f.calls.map((call) => call.options.agentWorkspaceDirectory)).toEqual([
      f.work,
      f.work,
      f.work,
    ]);
    expect(f.calls[1]!.options.sessionId).not.toBe(f.calls[2]!.options.sessionId);
    expect(
      events.filter((e) => e.type === "text-delta").map((e) => e.conversation?.conversationId),
    ).toEqual([a.conversationId, b.conversationId, a.conversationId]);
  } finally {
    await session.dispose();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("restart resumes each conversation identity without using the control session as group history", async () => {
  const f = await fixture();
  let session = await f.open();
  try {
    await session.notify!("alpha first", { conversation: a });
    const first = await f.calls[1]!.session.readSessionIdentity!();
    await session.dispose();
    session = await f.open();
    await session.notify!("alpha after restart", { conversation: a });
    expect(f.calls.at(-1)!.options.sessionId).toBe(first!.sessionId);
    expect(f.calls.at(-1)!.options.sessionMode).toBe("resume");
    expect(f.calls.at(-1)!.options.sessionId).not.toBe("control-session");
  } finally {
    await session.dispose();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("concurrent first delivery creates only one native session for a conversation", async () => {
  const f = await fixture();
  const session = await f.open();
  try {
    await Promise.all([
      session.notify!("one", { conversation: a }),
      session.notify!("two", { conversation: a }),
    ]);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.messages).toEqual(["one", "two"]);
  } finally {
    await session.dispose();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("Session Reset leaves shared files but starts fresh conversation histories", async () => {
  const f = await fixture();
  let session = await f.open();
  try {
    await session.notify!("first", { conversation: a });
    const old = f.calls.at(-1)!.options.sessionId;
    await Bun.write(join(f.work, "shared.txt"), "shared knowledge");
    await session.dispose();
    session = await f.open("new-control-session");
    await session.notify!("after reset", { conversation: a });
    expect(f.calls.at(-1)!.options.sessionId).not.toBe(old);
    expect(f.calls.at(-1)!.options.sessionMode).toBe("create");
    expect(await Bun.file(join(f.work, "shared.txt")).text()).toBe("shared knowledge");
  } finally {
    await session.dispose();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

// Native turn completion and disposal are explicit test-controlled provider events.
function liveFixture() {
  const providers: {
    session: AgentSession;
    notifyCalls: string[];
    stopped: boolean;
    emit(event: AgentRuntimeEvent): void;
    disposal?: ReturnType<typeof deferred<void>>;
  }[] = [];
  const created = deferred<void>();
  const overlaps: string[] = [];
  const create = async (options: AgentSessionOptions) => {
    const listeners = new Set<(event: AgentRuntimeEvent) => void>();
    const exits = new Set<() => void>();
    let live = false;
    const native = {
      session: undefined as unknown as AgentSession,
      notifyCalls: [] as string[],
      stopped: false,
      emit(event: AgentRuntimeEvent) {
        if (event.type === "completed") live = false;
        for (const listener of listeners) listener(event);
      },
      disposal: undefined as ReturnType<typeof deferred<void>> | undefined,
    };
    native.session = {
      get hasLiveTurn() {
        return live;
      },
      sendMessage: async () => {},
      notify: async (text: string) => {
        if (
          providers.some(
            (provider) => provider !== native && !provider.stopped && provider.session.hasLiveTurn,
          )
        )
          overlaps.push(text);
        live = true;
        native.notifyCalls.push(text);
      },
      readSessionIdentity: async () => ({
        sessionId: options.sessionId ?? "control",
        state: "resumable" as const,
      }),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onExit: (listener) => {
        exits.add(listener);
        return () => exits.delete(listener);
      },
      interrupt: async () => {
        native.emit({ type: "completed", status: "interrupted" });
      },
      dispose: async () => {
        await native.disposal?.promise;
        native.stopped = true;
        for (const exit of exits) exit();
      },
    };
    providers.push(native);
    if (providers.length === 3) created.resolve();
    return native.session;
  };
  const open = async () => {
    const options = {
      agentWorkspaceDirectory: "/test/shared",
      instructions: "Memory",
      sessionId: "control",
    };
    return new MemoryConversationSessions({ primary: await create(options), options, create });
  };
  return { providers, created, overlaps, open };
}

test("Stop cancels cross-group notices waiting behind a live turn", async () => {
  const f = liveFixture();
  const session = await f.open();
  try {
    await session.notify("alpha", { conversation: a });
    const queued = session.notify("beta", { conversation: b });
    const outcome = queued.then(
      () => undefined,
      (error) => error as Error,
    );
    await f.created.promise;
    session.cancelPendingNotices!();
    expect((await outcome)?.message).toContain("stopping");
    f.providers[1]!.emit({ type: "completed", status: "completed" });
    expect(f.providers[2]!.notifyCalls).toEqual([]);
  } finally {
    await session.dispose();
  }
});

test("purging a group prevents its pending creation or queued notice from running", async () => {
  const f = liveFixture();
  const session = await f.open();
  try {
    await session.notify("alpha", { conversation: a });
    const queued = session.notify("beta", { conversation: b });
    const outcome = queued.then(
      () => undefined,
      (error) => error as Error,
    );
    await f.created.promise;
    await session.purgeConversation!(b.conversationId);
    expect((await outcome)?.message).toContain("purged");
    f.providers[1]!.emit({ type: "completed", status: "completed" });
    expect(f.providers[2]!.notifyCalls).toEqual([]);
  } finally {
    await session.dispose();
  }
});

test("concurrent disposal waits for every native child to stop", async () => {
  const f = liveFixture();
  const session = await f.open();
  const gate = deferred<void>();
  const stopping: Promise<void>[] = [];
  try {
    await session.notify("alpha", { conversation: a });
    f.providers[1]!.disposal = gate;
    let stopped = false;
    stopping.push(
      session.dispose(),
      session.dispose().then(() => {
        expect(f.providers[1]!.stopped).toBe(true);
        stopped = true;
      }),
    );
    expect(stopped).toBe(false);
    gate.resolve();
    await Promise.all(stopping);
    expect(stopped).toBe(true);
  } finally {
    gate.resolve();
    await Promise.allSettled(stopping);
    await session.dispose();
  }
});

test("different groups wait for native turn completion while same-group notices can steer", async () => {
  const f = liveFixture();
  const session = await f.open();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await session.notify("alpha first", { conversation: a });
    await session.notify("alpha steer", { conversation: a });
    const beta = session.notify("beta", { conversation: b });
    // The provider ends A on the next event-loop turn. All in-memory B creation microtasks
    // run before that native boundary; starting B early is observed as overlapping work.
    timer = setTimeout(() => f.providers[1]!.emit({ type: "completed", status: "completed" }), 0);
    await beta;
    expect(f.overlaps).toEqual([]);
    expect(f.providers[1]!.notifyCalls).toEqual(["alpha first", "alpha steer"]);
    expect(f.providers[2]!.notifyCalls).toEqual(["beta"]);
  } finally {
    clearTimeout(timer);
    await session.dispose();
  }
});

test("an exited group releases another group's pending notice without exiting the Agent", async () => {
  const f = liveFixture();
  const session = await f.open();
  try {
    await session.notify("alpha", { conversation: a });
    const beta = session.notify("beta", { conversation: b });
    await f.created.promise;
    await f.providers[1]!.session.dispose();
    await beta;
    expect(f.providers[2]!.notifyCalls).toEqual(["beta"]);
    expect(f.providers[0]!.stopped).toBe(false);
  } finally {
    await session.dispose();
  }
});

for (const action of ["stop", "purge"] as const)
  test(`${action} reports a child cleanup failure when cancellation overlaps creation`, async () => {
    const entered = deferred<void>();
    const gate = deferred<void>();
    const callbacks = new Set<() => void>();
    const primary: AgentSession = {
      sendMessage: async () => {},
      readSessionIdentity: async () => ({ sessionId: "control", state: "resumable" }),
      subscribe: () => () => {},
      onExit: (listener) => {
        callbacks.add(listener);
        return () => callbacks.delete(listener);
      },
      interrupt: async () => {},
      dispose: async () => {},
    };
    const child: AgentSession = {
      ...primary,
      dispose: async () => {
        throw new Error("native child still running");
      },
    };
    const session = new MemoryConversationSessions({
      primary,
      options: { agentWorkspaceDirectory: "/test/shared", instructions: "Memory" },
      create: async () => {
        entered.resolve();
        await gate.promise;
        return child;
      },
    });
    const notice = session.notify("alpha", { conversation: a }).catch(() => {});
    let cleanup: Promise<unknown> | undefined;
    try {
      await entered.promise;
      cleanup = (
        action === "stop" ? session.dispose() : session.purgeConversation(a.conversationId)
      ).then(
        () => undefined,
        (error) => error,
      );
      gate.resolve();
      expect(await cleanup).toBeInstanceOf(Error);
    } finally {
      gate.resolve();
      await notice;
      await cleanup;
      await session.dispose().catch(() => {});
    }
  });

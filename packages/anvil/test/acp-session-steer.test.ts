import { expect, test } from "bun:test";
import type { AgentRuntimeEvent, AgentSessionOptions } from "@coforge/agent";
import type { AcpConnection } from "#src/acp/connection";
import type { AcpSessionProfile, AcpSessionSink, AcpTurnReader } from "#src/acp/profile";
import { AcpSession } from "#src/acp/session";

/** One request the session wrote, settled by the test as the runtime would answer it. */
type PendingRequest = {
  method: string;
  params: unknown;
  resolve(value: unknown): void;
  reject(error: unknown): void;
};

const TURN: AcpTurnReader = {
  read: (update) =>
    update.sessionUpdate === "text" ? [{ type: "text-delta", text: String(update.text) }] : [],
  end: () => [],
};

/** A session over a fake transport: the test answers its requests and feeds its notifications. */
async function openSession(
  steer: AcpSessionProfile["steer"],
  openSession: AcpSessionProfile["openSession"] = async () => ({
    sessionId: "s1",
    resumable: true,
  }),
  waitForOpen = true,
) {
  const requests: PendingRequest[] = [];
  const waiters: { method: string; deliver(entry: PendingRequest): void }[] = [];
  const delivered = new Set<PendingRequest>();
  const nextRequest = (method: string) => {
    const existing = requests.find((entry) => entry.method === method && !delivered.has(entry));
    if (existing) {
      delivered.add(existing);
      return Promise.resolve(existing);
    }
    return new Promise<PendingRequest>((resolve) =>
      waiters.push({
        method,
        deliver: (entry) => {
          delivered.add(entry);
          resolve(entry);
        },
      }),
    );
  };
  let sink: AcpSessionSink | undefined;
  const connection = {
    process: { onFailure: () => () => {}, onClose: () => () => {} },
    initialize: async () => ({ protocolVersion: 1 }),
    dispose: async () => {},
    connection: {
      agent: {
        request: (method: string, params: unknown) =>
          new Promise((resolve, reject) => {
            const entry = { method, params, resolve, reject };
            requests.push(entry);
            const index = waiters.findIndex((waiter) => waiter.method === method);
            if (index >= 0) waiters.splice(index, 1)[0]!.deliver(entry);
          }),
        notify: async () => {},
      },
    },
  } as unknown as AcpConnection;
  const events: AgentRuntimeEvent[] = [];
  const session = new AcpSession(
    {
      label: "Test",
      openTransport: (value) => {
        sink = value;
        return connection;
      },
      openSession,
      turn: () => TURN,
      steer,
    },
    { agentWorkspaceDirectory: "/tmp", instructions: "" } satisfies AgentSessionOptions,
    1_000,
    (work) => work,
  );
  session.subscribe((event) => events.push(event));
  const opened = session.open();
  if (waitForOpen) await opened;
  return {
    session,
    events,
    opened,
    nextRequest,
    update: (update: Record<string, unknown>) => sink!.update("s1", update),
    notification: (method: string, params: Record<string, unknown>) =>
      sink!.notification(method, params),
  };
}

/** The steer shape Kiro declares: a queued answer with a native id and delivery outcomes. */
function steerProfile(abandoned: string[]) {
  return {
    request: (text: string, sessionId: string) => ({
      method: "_test/steer",
      params: { sessionId, text },
    }),
    accepted: (response: unknown) => {
      const answer = response as { queued?: boolean; messageId?: string };
      return answer.queued ? { accepted: true, id: answer.messageId } : { accepted: false };
    },
    outcome: (method: string, params: Readonly<Record<string, unknown>>) =>
      method === "_test/outcome"
        ? { id: String(params.id), state: params.state as "injected" | "cleared" }
        : undefined,
    abandon: async (id: string) => {
      abandoned.push(id);
    },
    nativeTurn: (method: string, params: Readonly<Record<string, unknown>>) =>
      method === "_test/native"
        ? params.status
          ? {
              promptId: String(params.promptId),
              end: { status: params.status as "completed" },
            }
          : { promptId: String(params.promptId) }
        : undefined,
  };
}

/** Starts one admitted turn the test can steer into. */
async function busyTurn(harness: Awaited<ReturnType<typeof openSession>>) {
  const admission = harness.session.notify("first");
  const prompt = await harness.nextRequest("session/prompt");
  harness.update({ sessionUpdate: "text", text: "hello" });
  await admission;
  return prompt;
}

test("a steered notice settles on the runtime's answer and reports a cleared outcome", async () => {
  const abandoned: string[] = [];
  const harness = await openSession(steerProfile(abandoned));
  const prompt = await busyTurn(harness);
  const steered = harness.session.notify("second");
  const insert = await harness.nextRequest("_test/steer");
  insert.resolve({ queued: true, messageId: "m1" });
  await steered;
  harness.notification("_test/outcome", { id: "m1", state: "cleared" });
  expect(harness.events.filter((event) => event.type === "notice-undelivered")).toEqual([
    { type: "notice-undelivered", text: "second" },
  ]);
  prompt.resolve({ stopReason: "end_turn" });
  await harness.session.dispose();
});

test("a steer outcome that arrives before its answer is not lost", async () => {
  const abandoned: string[] = [];
  const harness = await openSession(steerProfile(abandoned));
  const prompt = await busyTurn(harness);
  const steered = harness.session.notify("second");
  const insert = await harness.nextRequest("_test/steer");
  harness.notification("_test/outcome", { id: "m1", state: "cleared" });
  insert.resolve({ queued: true, messageId: "m1" });
  await steered;
  expect(harness.events.filter((event) => event.type === "notice-undelivered")).toEqual([
    { type: "notice-undelivered", text: "second" },
  ]);
  prompt.resolve({ stopReason: "end_turn" });
  await harness.session.dispose();
});

test("a refused steer keeps one acknowledgement and is reported undelivered", async () => {
  const abandoned: string[] = [];
  const harness = await openSession(steerProfile(abandoned));
  const prompt = await busyTurn(harness);
  const steered = harness.session.notify("second");
  (await harness.nextRequest("_test/steer")).resolve({ queued: false });
  await steered;
  expect(harness.events.filter((event) => event.type === "notice-undelivered")).toEqual([
    { type: "notice-undelivered", text: "second" },
  ]);
  prompt.resolve({ stopReason: "end_turn" });
  await harness.session.dispose();
});

test("a steer accepted after its turn ended is taken back and reported undelivered", async () => {
  const abandoned: string[] = [];
  const harness = await openSession(steerProfile(abandoned));
  const prompt = await busyTurn(harness);
  const steered = harness.session.notify("second");
  const insert = await harness.nextRequest("_test/steer");
  prompt.resolve({ stopReason: "end_turn" });
  await Bun.sleep(5);
  insert.resolve({ queued: true, messageId: "m1" });
  await steered;
  expect(abandoned).toEqual(["m1"]);
  expect(harness.events.filter((event) => event.type === "notice-undelivered")).toEqual([
    { type: "notice-undelivered", text: "second" },
  ]);
  await harness.session.dispose();
});

test("a steer the turn ends without confirming never reached the model", async () => {
  const abandoned: string[] = [];
  const harness = await openSession(steerProfile(abandoned));
  const prompt = await busyTurn(harness);
  const steered = harness.session.notify("second");
  (await harness.nextRequest("_test/steer")).resolve({ queued: true, messageId: "m1" });
  await steered;
  prompt.resolve({ stopReason: "end_turn" });
  await Bun.sleep(5);
  expect(harness.events.filter((event) => event.type === "notice-undelivered")).toEqual([
    { type: "notice-undelivered", text: "second" },
  ]);
  await harness.session.dispose();
});

test("a turn the runtime starts itself is projected and completes once", async () => {
  const harness = await openSession(steerProfile([]));
  harness.notification("_test/native", { promptId: "n1" });
  expect(harness.session.hasLiveTurn).toBe(true);
  harness.update({ sessionUpdate: "text", text: "fallback output" });
  harness.notification("_test/native", { promptId: "n1", status: "completed" });
  expect(harness.events).toContainEqual({ type: "text-delta", text: "fallback output" });
  expect(harness.events.filter((event) => event.type === "completed")).toEqual([
    { type: "completed", status: "completed" },
  ]);
  expect(harness.session.hasLiveTurn).toBe(false);
  await harness.session.dispose();
});

test("a turn that starts and ends before the session is reported is not revived", async () => {
  const gate = Promise.withResolvers<void>();
  const harness = await openSession(
    steerProfile([]),
    async () => {
      await gate.promise;
      return { sessionId: "s1", resumable: true };
    },
    false,
  );
  harness.notification("_test/native", { sessionId: "s1", promptId: "n1" });
  harness.notification("_test/native", { sessionId: "s1", promptId: "n1", status: "completed" });
  gate.resolve();
  await harness.opened;
  expect(harness.events).toEqual([]);
  expect(harness.session.hasLiveTurn).toBe(false);
  await harness.session.dispose();
});

test("a turn still running when the session is reported is adopted", async () => {
  const gate = Promise.withResolvers<void>();
  const harness = await openSession(
    steerProfile([]),
    async () => {
      await gate.promise;
      return { sessionId: "s1", resumable: true };
    },
    false,
  );
  harness.notification("_test/native", { sessionId: "s1", promptId: "n1" });
  gate.resolve();
  await harness.opened;
  expect(harness.session.hasLiveTurn).toBe(true);
  harness.update({ sessionUpdate: "text", text: "still running" });
  expect(harness.events).toContainEqual({ type: "text-delta", text: "still running" });
  harness.notification("_test/native", { sessionId: "s1", promptId: "n1", status: "completed" });
  expect(harness.events.filter((event) => event.type === "completed")).toEqual([
    { type: "completed", status: "completed" },
  ]);
  expect(harness.session.hasLiveTurn).toBe(false);
  await harness.session.dispose();
});

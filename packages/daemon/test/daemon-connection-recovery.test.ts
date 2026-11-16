import { expect, test } from "bun:test";
import {
  decodeReminderFireRequest,
  encodeReminderFireResponse,
  REMINDER_FIRE_METHOD,
  type AgentReminderOperationRequest,
  type ReminderFireRequest,
  type ReminderJob,
  type ReminderSync,
} from "@lrm/coforge-sdk/internal";
import {
  ReminderScheduler,
  type ReminderClock,
  type ReminderReceipt,
  type ReminderReceiptStore,
} from "#src/agent-reminder/reminder-scheduler";
import { DaemonConnection } from "#src/connection/daemon-connection";
import type { DaemonConnectionTiming } from "#src/connection/daemon-connection-timing";
import { captureDaemonLogs } from "./log-capture";
import { config, fakeClient } from "./daemon-connection.test";

/**
 * The daemon connection's up-ness is derived from the client it holds, never stored beside it.
 * Kept separately, the two drifted apart once: a `start` that rejected after its client had
 * connected left the object "connected" with no client, so every HTTPS path kept working while
 * every RPC answered "daemon connection is not connected" — messages arrived, reminders never
 * fired, and nothing rebuilt the connection for three days (2026-11-16).
 *
 * Each test below pins one half of the fix: the invariant, the dependency split it forced, and the
 * self-heal that a clientless connection needs because no caller was left to retry it.
 */

const AGENT_API_KEY = `sk_agent_${"a".repeat(43)}`;

const reminderFire: ReminderFireRequest = {
  protocolMajor: 1,
  requestId: "b0b0b0b0-1111-4111-8111-b0b0b0b0b0b0",
  workspaceId: config.workspaceId,
  computerId: config.computerId,
  agentId: "agent-a",
  reminderId: "123e4567-e89b-42d3-a456-426614174000",
  version: 3,
  firedAtClient: "2026-09-08T12:00:01Z",
};

const reminderOperation: AgentReminderOperationRequest = {
  idempotencyKey: "request-reminder",
  workspaceId: config.workspaceId,
  computerId: config.computerId,
  agentId: "agent-a",
  operation: "list",
};

/** Records every RPC the connection puts on the wire, and answers a reminder fire with the
 * acceptance the server would send back, correlated with the request it was given. */
function recordRpc(fake: ReturnType<typeof fakeClient>): string[] {
  const calls: string[] = [];
  fake.client.rpc = async (method, data) => {
    calls.push(method);
    if (method !== REMINDER_FIRE_METHOD) return { data: new Uint8Array() };
    const request = decodeReminderFireRequest(data);
    return {
      data: encodeReminderFireResponse({
        ...request,
        result: "accepted",
        fired: true,
        catchup: false,
      }),
    };
  };
  return calls;
}

/** Timers and clock the test drives by hand, so a liveness window passes without waiting. */
function manualTiming() {
  const scheduled: { callback: () => void; delayMs: number }[] = [];
  const repeating: { callback: () => void; delayMs: number }[] = [];
  const clock = { now: 0 };
  const timing: DaemonConnectionTiming = {
    now: () => clock.now,
    schedule: (callback, delayMs) => scheduled.push({ callback, delayMs }),
    cancel: () => {},
    scheduleRepeating: (callback, delayMs) => repeating.push({ callback, delayMs }),
    cancelRepeating: () => {},
  };
  return { scheduled, repeating, timing };
}

test("a start that rejects after its client connected leaves the connection down, and a later start rebuilds it", async () => {
  const clients: ReturnType<typeof fakeClient>[] = [];
  const transport = new DaemonConnection(
    "wss://cloud.example",
    () => {
      const fake = fakeClient();
      clients.push(fake);
      // The status call every connected handshake makes throws instead of rejecting: that lands
      // inside the connected handler, after the connection marked itself up and before `start`
      // could resolve — one shape of the rejection that stranded the production daemon.
      if (clients.length === 1)
        fake.client.rpc = () => {
          throw new Error("status rpc unavailable");
        };
      else recordRpc(fake);
      return fake.client;
    },
    undefined,
    manualTiming().timing,
  );

  await expect(transport.start("secret", config)).rejects.toThrow("status rpc unavailable");
  // Whatever the object thinks, RPC has to say so: the client that connected is gone.
  await expect(transport.fireReminder(reminderFire)).rejects.toThrow(
    "daemon connection is not connected",
  );

  // The invariant is only worth anything if recovery follows it: this start has to build a client
  // rather than return early on a "connected" flag left behind by the attempt that failed.
  await transport.start("secret", config);
  expect(clients).toHaveLength(2);
  await expect(transport.fireReminder(reminderFire)).resolves.toMatchObject({
    result: "accepted",
  });
  await transport.stop();
});

test("an Agent message keeps working through a reconnect window; only the RPC path stops", async () => {
  const fake = fakeClient();
  const urls: string[] = [];
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client, {
    async requestReminder({ url, request }) {
      urls.push(url);
      return { ...request, accepted: true, reminders: [], events: [] };
    },
  });
  await transport.start("daemon-token", { ...config, serverHttpUrl: "https://server.example" });

  // A flap the client rides out on its own: the socket is down, the server's HTTPS origin is not.
  fake.disconnect({ code: 0, reason: "disconnect called" });

  // Asserted as succeeding because the message is an HTTPS call with the Agent's own key: the
  // server answers it whatever the WebSocket is doing, and refusing it here failed messages for
  // the seconds a reconnect takes (2026-11-16). Only the origin it depends on is checked.
  await expect(transport.agentReminder(reminderOperation, AGENT_API_KEY)).resolves.toMatchObject({
    accepted: true,
  });
  expect(urls).toHaveLength(1);
  // The same instant, on the path that really does need the socket.
  await expect(transport.fireReminder(reminderFire)).rejects.toThrow(
    "daemon connection is not connected",
  );
  await transport.stop();

  // A connection that was never started has no origin to send to, which is the only thing these
  // paths may refuse for.
  const neverStarted = new DaemonConnection("wss://cloud.example", () => fakeClient().client, {
    async requestReminder({ request }) {
      return { ...request, accepted: true, reminders: [], events: [] };
    },
  });
  await expect(neverStarted.agentReminder(reminderOperation, AGENT_API_KEY)).rejects.toThrow(
    "HTTP endpoint is not configured",
  );
});

test("the status refresh rebuilds a clientless connection, and a reminder due after the flap then fires", async () => {
  const clients: ReturnType<typeof fakeClient>[] = [];
  const rpcCalls: string[][] = [];
  const { timing, repeating } = manualTiming();
  const transport = new DaemonConnection(
    "wss://cloud.example",
    () => {
      const fake = fakeClient();
      clients.push(fake);
      rpcCalls.push(recordRpc(fake));
      // The second client's handshake throws: that is the start which strands the connection.
      if (clients.length === 2)
        fake.client.rpc = () => {
          throw new Error("status rpc unavailable");
        };
      return fake.client;
    },
    undefined,
    timing,
  );

  await transport.start("secret", config);
  expect(repeating).toHaveLength(1);
  clients[0]!.disconnect({ code: 0, reason: "disconnect called" });
  await expect(transport.start("secret", config)).rejects.toThrow("status rpc unavailable");
  expect(clients).toHaveLength(2);

  // Nothing is left running that could retry this except the status refresh; one tick of it has to
  // put a client back (2026-11-16: nothing did, for three days).
  repeating[0]!.callback();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const store = new MemoryStore();
  const clock = new TestClock();
  const scheduler = new ReminderScheduler(
    { workspaceId: config.workspaceId, computerId: config.computerId },
    store,
    (request) => transport.fireReminder(request),
    async () => true,
    clock,
  );
  const { records } = await captureDaemonLogs(async () => {
    await scheduler.apply(snapshot([job]));
    await clock.advance(1000);
    // The fire runs through the receipt state machine, several awaits deep.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const failures = records.filter(
    (record) => (record.properties as { event?: string }).event === "reminder.fire_failed",
  );
  expect(failures).toHaveLength(0);
  expect(rpcCalls.flat()).toContain(REMINDER_FIRE_METHOD);
  // And the client the reminder went out on is the one the refresh rebuilt.
  expect(clients).toHaveLength(3);
  await transport.stop();
});

class MemoryStore implements ReminderReceiptStore {
  receipts: ReminderReceipt[] = [];
  async read() {
    return structuredClone(this.receipts);
  }
  async write(_agentId: string, receipts: readonly ReminderReceipt[]) {
    this.receipts = structuredClone([...receipts]);
  }
}

class TestClock implements ReminderClock {
  time = Date.parse("2026-09-08T12:00:00Z");
  timers: Array<{ at: number; callback: () => void }> = [];
  now = () => this.time;
  schedule(callback: () => void, delayMs: number) {
    const timer = { at: this.time + delayMs, callback };
    this.timers.push(timer);
    return timer;
  }
  cancel(timer: unknown) {
    this.timers = this.timers.filter((item) => item !== timer);
  }
  async advance(ms: number) {
    this.time += ms;
    const due = this.timers.filter((timer) => timer.at <= this.time);
    this.timers = this.timers.filter((timer) => timer.at > this.time);
    for (const timer of due) timer.callback();
    await Promise.all(due.map(async () => {}));
  }
}

const job: ReminderJob = {
  reminderId: reminderFire.reminderId,
  ownerAgentId: "agent-a",
  version: reminderFire.version,
  title: "Review",
  target: "@frank",
  messageId: "123e4567-e89b-42d3-a456-426614174001",
  fireAt: "2026-09-08T12:00:01Z",
};

const snapshot = (jobs: ReminderJob[]): ReminderSync => ({
  protocolMajor: 1,
  requestId: crypto.randomUUID(),
  workspaceId: config.workspaceId,
  computerId: config.computerId,
  agentId: "agent-a",
  operation: "snapshot",
  jobs,
  messageType: "coforge.rpc.v1.ReminderSync",
});

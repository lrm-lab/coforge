import { expect, test } from "bun:test";
import { DaemonConnection } from "#src/connection/daemon-connection";
import { gatedCentrifuge, readyRequest } from "./fixtures/gated-centrifuge";
import { ReminderScheduler } from "#src/agent-reminder/reminder-scheduler";
import { RuntimePublicationSubscriptions } from "#src/daemon-runtime/runtime-publication-subscriptions";
import {
  encodeAgentStopIntent,
  encodeReminderSync,
  type AgentStopIntent,
  type ReminderSync,
} from "@lrm/coforge-sdk/internal";
import { captureDaemonLogs } from "./log-capture";
import { Clock, job, MemoryStore, snapshot } from "./reminder-scheduler-fixtures";

const workspaceId = "workspace-a";
const computerId = "computer-a";

/**
 * The daemon holds a pending ready's publications in two places, one after the other: the
 * connection holds them until the cloud accepts ready, then the runtime's own subscriptions buffer
 * them until the start releases. A count meant to describe a stuck start has to cover both, or it
 * reads zero for exactly as long as the publications queue up.
 */
test("a publication queued behind a pending ready is reported as held", async () => {
  const centrifuge = gatedCentrifuge(workspaceId, computerId);
  const transport = new DaemonConnection("wss://cloud.example", () => centrifuge.client);
  await transport.start("secret", { workspaceId, computerId });
  const delivered: string[] = [];
  const subscriptions = new RuntimePublicationSubscriptions({
    transport,
    workspaceId,
    computerId,
    stopAgent: async (intent: AgentStopIntent) => void delivered.push(intent.agentId),
  } as unknown as ConstructorParameters<typeof RuntimePublicationSubscriptions>[0]);
  await subscriptions.install();

  const ready = transport.ready(() => readyRequest(workspaceId, computerId));
  centrifuge.publish(
    encodeAgentStopIntent({
      protocolMajor: 1,
      requestId: "stop-1",
      workspaceId,
      computerId,
      agentId: "agent-a",
    }),
  );

  // The cloud has not accepted ready, so the runtime's own subscriber never saw the Stop.
  expect(subscriptions.heldCount()).toBe(1);
  expect(delivered).toEqual([]);

  // The cloud accepts ready: the connection hands the Stop over, and the runtime's own buffer takes
  // it from there, so the run the start flushes is what finally delivers it.
  centrifuge.answerReady();
  await ready;
  expect(subscriptions.heldCount()).toBe(1);
  expect(delivered).toEqual([]);
  for (const flush of subscriptions.release().buffered) await flush();
  expect(delivered).toEqual(["agent-a"]);
  expect(subscriptions.heldCount()).toBe(0);
  await transport.stop();
});

test("logs a failed reminder sync application with its scope", async () => {
  let receive!: (sync: ReminderSync) => void;
  const subscriptions = new RuntimePublicationSubscriptions({
    transport: {
      onReminderSync(callback: (sync: ReminderSync) => void) {
        receive = callback;
        return () => undefined;
      },
    },
    workspaceId,
    computerId,
    applyReminderSync: async () => {
      throw new Error("invalid reminder snapshot");
    },
  } as unknown as ConstructorParameters<typeof RuntimePublicationSubscriptions>[0]);
  await subscriptions.install();

  const { records } = await captureDaemonLogs(async () => {
    receive({
      protocolMajor: 1,
      requestId: "snapshot-1",
      workspaceId,
      computerId,
      agentId: "agent-a",
      operation: "snapshot",
      jobs: [],
      messageType: "coforge.rpc.v1.ReminderSync",
    });
    await Bun.sleep(0);
  });
  expect(records).toContainEqual(
    expect.objectContaining({
      properties: expect.objectContaining({
        event: "reminder.sync_apply_failed",
        agent_id: "agent-a",
        operation: "snapshot",
        error_type: "Error",
      }),
    }),
  );
});

test("dispatches a held overdue snapshot through the scheduler to fireReminder", async () => {
  const centrifuge = gatedCentrifuge(workspaceId, computerId);
  const transport = new DaemonConnection("wss://cloud.example", () => centrifuge.client);
  await transport.start("secret", { workspaceId, computerId });
  const clock = new Clock();
  let fires = 0;
  const scheduler = new ReminderScheduler(
    { workspaceId, computerId },
    new MemoryStore(),
    async () => {
      fires += 1;
      return {
        protocolMajor: 1,
        requestId: "fire-1",
        workspaceId,
        computerId,
        agentId: "agent-a",
        reminderId: job.reminderId,
        version: job.version,
        firedAtClient: job.fireAt,
        result: "accepted",
        fired: true,
        catchup: false,
      };
    },
    async () => true,
    clock,
  );
  const subscriptions = new RuntimePublicationSubscriptions({
    transport,
    workspaceId,
    computerId,
    applyReminderSync: (sync: ReminderSync) => scheduler.apply(sync),
  } as unknown as ConstructorParameters<typeof RuntimePublicationSubscriptions>[0]);
  await subscriptions.install();

  const ready = transport.ready(() => readyRequest(workspaceId, computerId));
  centrifuge.publish(
    encodeReminderSync({
      ...snapshot([job]),
      requestId: "snapshot-1",
    }),
  );
  expect(fires).toBe(0);
  centrifuge.answerReady();
  await ready;
  await clock.advance(1_000);
  await scheduler.awaitIdle();
  expect(fires).toBe(1);
  scheduler.stop();
  await transport.stop();
});

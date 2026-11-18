import { expect, test } from "bun:test";
import { DaemonConnection } from "#src/connection/daemon-connection";
import { RuntimePublicationSubscriptions } from "#src/daemon-runtime/runtime-publication-subscriptions";
import {
  REMINDER_DUE_MESSAGE_TYPE,
  REMINDER_SYNC_MESSAGE_TYPE,
  encodeReminderDue,
  encodeReminderSync,
  type ReminderDue,
} from "@lrm/coforge-sdk/internal";
import { gatedCentrifuge, readyRequest } from "./fixtures/gated-centrifuge";
import { captureDaemonLogs } from "./log-capture";

const workspaceId = "019b0381-1111-7111-8111-111111111111";
const computerId = "019b0381-2222-7222-8222-222222222222";
const agentId = "019b0381-3333-7333-8333-333333333333";

const job = {
  reminderId: "019b0381-5555-7555-8555-555555555555",
  ownerAgentId: agentId,
  version: 7,
  title: "Check the build",
  target: "#engineering",
  messageId: "019b0381-6666-7666-8666-666666666666",
  fireAt: "2026-11-17T00:00:00.000Z",
};

const due = (overrides: Partial<ReminderDue> = {}): ReminderDue => ({
  protocolMajor: 1,
  workspaceId,
  computerId,
  agentId,
  occurrenceId: "019b0381-4444-7444-8444-444444444444",
  job,
  expiresAt: "2026-11-24T00:00:00.000Z",
  messageType: REMINDER_DUE_MESSAGE_TYPE,
  ...overrides,
});

async function harness(receiveReminderDue: (due: ReminderDue) => Promise<void>) {
  const centrifuge = gatedCentrifuge(workspaceId, computerId);
  const transport = new DaemonConnection("wss://cloud.example", () => centrifuge.client);
  await transport.start("secret", { workspaceId, computerId });
  const subscriptions = new RuntimePublicationSubscriptions({
    transport,
    workspaceId,
    computerId,
    receiveReminderDue,
  } as unknown as ConstructorParameters<typeof RuntimePublicationSubscriptions>[0]);
  await subscriptions.install();
  const ready = transport.ready(() => readyRequest(workspaceId, computerId));
  const accept = async () => {
    centrifuge.answerReady();
    await ready;
    for (const flush of subscriptions.release().buffered) await flush();
  };
  return { centrifuge, transport, accept };
}

test("a Due published while ready is pending reaches the receiver once ready is accepted", async () => {
  const received: ReminderDue[] = [];
  const { centrifuge, transport, accept } = await harness(async (value) => {
    received.push(value);
  });
  centrifuge.publish(encodeReminderDue(due()));
  centrifuge.publish(
    encodeReminderDue(due({ computerId: "019b0381-7777-7777-8777-777777777777" })),
  );
  expect(received).toEqual([]);
  await accept();
  expect(received).toEqual([due()]);
  await transport.stop();
});

test("a ReminderSync is consumed without reaching the receiver and without a warning", async () => {
  const received: ReminderDue[] = [];
  const { centrifuge, transport, accept } = await harness(async (value) => {
    received.push(value);
  });
  await accept();
  const { records } = await captureDaemonLogs(async () => {
    centrifuge.publish(
      encodeReminderSync({
        protocolMajor: 1,
        requestId: crypto.randomUUID(),
        workspaceId,
        computerId,
        agentId,
        operation: "snapshot",
        jobs: [job],
        messageType: REMINDER_SYNC_MESSAGE_TYPE,
      }),
    );
    await Bun.sleep(0);
  });
  expect(received).toEqual([]);
  expect(
    records.filter((record) => record.level === "warning" || record.level === "error"),
  ).toEqual([]);
  await transport.stop();
});

test("a Due the runtime fails to take in is logged with its occurrence", async () => {
  const { centrifuge, transport, accept } = await harness(async () => {
    throw new Error("disk full");
  });
  await accept();
  const { records } = await captureDaemonLogs(async () => {
    centrifuge.publish(encodeReminderDue(due()));
    await Bun.sleep(0);
  });
  expect(records).toContainEqual(
    expect.objectContaining({
      properties: expect.objectContaining({
        event: "reminder.due_receive_failed",
        agent_id: agentId,
        occurrence_id: due().occurrenceId,
      }),
    }),
  );
  await transport.stop();
});

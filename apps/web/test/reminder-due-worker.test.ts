import { expect, test } from "bun:test";
import { ReminderDueWorker } from "#src/server/reminders/reminder-due-worker.server";
import type { ReminderDue } from "@lrm/coforge-sdk/internal";
import {
  encodeReminderDueAckRequest,
  decodeReminderDueAckResponse,
} from "@lrm/coforge-sdk/internal";
import { createReminderDueAckMethod } from "#src/server/centrifugo/reminder-due-ack-method.server";

const now = new Date("2026-11-17T00:01:00.000Z");
const occurrence: ReminderDue = {
  protocolMajor: 1,
  occurrenceId: "019b0381-4444-7444-8444-444444444444",
  workspaceId: "workspace",
  computerId: "computer",
  agentId: "agent",
  messageType: "reminder:due:v1",
  expiresAt: "2026-11-24T00:00:00.000Z",
  job: {
    reminderId: "019b0381-5555-7555-8555-555555555555",
    ownerAgentId: "agent",
    version: 1,
    title: "Review",
    target: "#general",
    messageId: "019b0381-6666-7666-8666-666666666666",
    fireAt: "2026-11-17T00:00:00.000Z",
  },
};

test("claim commits before publish and a failed send remains available for replay", async () => {
  let committed = false;
  let sends = 0;
  const worker = new ReminderDueWorker(
    {
      claim: async () => {
        committed = true;
      },
      expire: async () => [],
      pending: async () => [occurrence],
      acknowledge: async () => false,
    },
    async () => {
      expect(committed).toBe(true);
      if (++sends === 1) throw new Error("offline");
      return [{ status: "fulfilled", value: undefined }];
    },
  );
  await worker.tick(now);
  await worker.tick(now);
  expect(sends).toBe(2);
});

test("reconnect replay is scoped to the authenticated Computer", async () => {
  const scopes: unknown[] = [];
  let claims = 0;
  const worker = new ReminderDueWorker(
    {
      claim: async () => {
        claims++;
      },
      expire: async () => [],
      pending: async (_now, scope) => {
        scopes.push(scope);
        return [];
      },
      acknowledge: async () => false,
    },
    async () => [],
  );
  await worker.replay({ workspaceId: "workspace", computerId: "computer" }, now);
  expect(claims).toBe(0);
  expect(scopes).toEqual([{ workspaceId: "workspace", computerId: "computer" }]);
});

test("transport ACK rejects a forged Computer before mutating custody", async () => {
  let calls = 0;
  const worker = new ReminderDueWorker(
    {
      claim: async () => {},
      expire: async () => [],
      pending: async () => [],
      acknowledge: async () => {
        calls++;
        return true;
      },
    },
    async () => [],
  );
  const method = createReminderDueAckMethod(worker);
  const request = encodeReminderDueAckRequest({
    protocolMajor: 1,
    requestId: "ack",
    workspaceId: "workspace",
    computerId: "forged",
    agentId: "agent",
    occurrenceId: occurrence.occurrenceId,
    reminderId: occurrence.job.reminderId,
    version: 1,
  });
  const result = await method(request, {
    principal: { userId: "owner", workspaceId: "workspace", computerId: "computer" },
  });
  expect(result).toMatchObject({ code: 403 });
  expect(calls).toBe(0);
});

test("transport ACK returns the exact identity and acceptance without changing user acknowledgement", async () => {
  const request = {
    protocolMajor: 1,
    requestId: "ack",
    workspaceId: "workspace",
    computerId: "computer",
    agentId: "agent",
    occurrenceId: occurrence.occurrenceId,
    reminderId: occurrence.job.reminderId,
    version: 1,
  };
  const worker = new ReminderDueWorker(
    {
      claim: async () => {},
      expire: async () => [],
      pending: async () => [],
      acknowledge: async (value) => {
        expect(value).toEqual(request);
        return true;
      },
    },
    async () => [],
  );
  const result = await createReminderDueAckMethod(worker)(encodeReminderDueAckRequest(request), {
    principal: { userId: "owner", workspaceId: "workspace", computerId: "computer" },
  });
  expect(result).toBeInstanceOf(Uint8Array);
  expect(decodeReminderDueAckResponse(result as Uint8Array)).toMatchObject({
    ...request,
    accepted: true,
  });
});

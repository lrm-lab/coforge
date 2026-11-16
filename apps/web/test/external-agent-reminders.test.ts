import { describe, expect, test } from "bun:test";
import { handleAgentReminderPost } from "#src/routes/api/agent/v1/reminders";

const IDS = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  computerId: "22222222-2222-4222-8222-222222222222",
  agentId: "33333333-3333-4333-8333-333333333333",
  idempotencyKey: "44444444-4444-4444-8444-444444444444",
};
const REMINDER_ID = "55555555-5555-4555-8555-555555555555";
const principal = {
  workspaceId: IDS.workspaceId,
  agentId: IDS.agentId,
  computerId: "",
  userId: "user-1",
  external: true as const,
};

function post(body: Record<string, unknown>) {
  return new Request("https://example.test/api/agent/v1/reminders", {
    method: "POST",
    body: JSON.stringify({ ...IDS, ...body }),
  });
}

function serviceThatMustNotRun() {
  const calls: unknown[] = [];
  return {
    calls,
    service: async (command: unknown) => {
      calls.push(command);
      throw new Error("the daemon path must not run for an external Agent");
    },
  };
}

describe("reminders for an external Agent", () => {
  test.each([
    ["schedule", { title: "t", target: "#general", messageId: "abcdef12", delaySeconds: 60 }],
    ["update", { reminderId: REMINDER_ID, title: "t" }],
    ["snooze", { reminderId: REMINDER_ID, delaySeconds: 60 }],
  ])("%s is refused as unsupported", async (operation, fields) => {
    const { service, calls } = serviceThatMustNotRun();
    const response = await handleAgentReminderPost(
      post({ operation, ...fields }),
      principal,
      service,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "This operation is not available to external Agents",
      code: "unsupported_for_external_agents",
      feature: `reminders.${operation}`,
      retryable: false,
    });
    expect(calls).toEqual([]);
  });

  test("list and log answer with the service's normal empty result", async () => {
    const { service, calls } = serviceThatMustNotRun();
    for (const body of [{ operation: "list" }, { operation: "log", reminderId: REMINDER_ID }]) {
      const response = await handleAgentReminderPost(post(body), principal, service);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        idempotencyKey: IDS.idempotencyKey,
        workspaceId: IDS.workspaceId,
        computerId: IDS.computerId,
        agentId: IDS.agentId,
        accepted: true,
        reminders: [],
        events: [],
      });
    }
    expect(calls).toEqual([]);
  });

  test("cancel is the normal not-found refusal", async () => {
    const { service, calls } = serviceThatMustNotRun();
    const response = await handleAgentReminderPost(
      post({ operation: "cancel", reminderId: REMINDER_ID }),
      principal,
      service,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid reminder request",
      code: "NOT_FOUND",
    });
    expect(calls).toEqual([]);
  });

  test("another Agent's scope is still denied", async () => {
    const { service } = serviceThatMustNotRun();
    const response = await handleAgentReminderPost(
      post({ operation: "list", agentId: "66666666-6666-4666-8666-666666666666" }),
      principal,
      service,
    );
    expect(response.status).toBe(403);
  });

  test("a managed Agent still reaches the service and needs its own Computer", async () => {
    const managed = { ...principal, computerId: IDS.computerId, external: undefined };
    let ran = false;
    const response = await handleAgentReminderPost(
      post({ operation: "list" }),
      managed,
      async (command) => {
        ran = true;
        return { ...command, accepted: true, reminders: [], events: [] } as never;
      },
    );
    expect(response.status).toBe(200);
    expect(ran).toBe(true);
    const wrongComputer = await handleAgentReminderPost(
      post({ operation: "list", computerId: "77777777-7777-4777-8777-777777777777" }),
      managed,
      async () => {
        throw new Error("unreachable");
      },
    );
    expect(wrongComputer.status).toBe(403);
  });
});

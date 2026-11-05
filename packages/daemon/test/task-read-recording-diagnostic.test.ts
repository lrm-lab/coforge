import { expect, test } from "bun:test";
import { forwardedTaskReadResponse } from "#src/daemon-runtime/forwarded-task-read-response";
import { captureDaemonLogs } from "./log-capture";

const request = { route: "read", query: {} } as never;

test("a task read whose response carries no scope logs why its cursor was not recorded", async () => {
  const { records } = await captureDaemonLogs(async () => {
    await forwardedTaskReadResponse(
      {
        agentId: "agent-a",
        request,
        recordRead: () => {
          throw new Error("an unscoped read must not record");
        },
      },
      Response.json({ messages: [{ sequence: 1 }] }),
    );
  });
  expect(
    records.find((record) => record.properties.event === "agent.task_read.not_recorded")
      ?.properties,
  ).toMatchObject({
    agent_id: "agent-a",
    reason: "scope_missing_or_foreign",
    has_consumption_scope: false,
  });
});

test("a task read with a matching scope records, and logs no refusal", async () => {
  let recorded = 0;
  const { records } = await captureDaemonLogs(async () => {
    await forwardedTaskReadResponse(
      { agentId: "agent-a", request, recordRead: () => void recorded++ },
      Response.json({
        messages: [{ sequence: 1 }],
        consumptionScope: {
          agentId: "agent-a",
          conversationId: "conversation-a",
          channelType: "thread",
          target: "#board:#7",
        },
      }),
    );
  });
  expect(recorded).toBe(1);
  expect(records.some((record) => record.properties.event === "agent.task_read.not_recorded")).toBe(
    false,
  );
});

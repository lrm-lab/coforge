import { expect, test } from "bun:test";
import type { LogRecord } from "@logtape/logtape";
import { captureDaemonLogs } from "./log-capture";
import { forwardedTaskReadResponse } from "#src/daemon-runtime/forwarded-task-read-response";

const request = { route: "read", query: { unread: "true" } } as never;

const page = (overrides: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      consumptionScope: {
        agentId: "agent-1",
        conversationId: "conversation-1",
        channelType: "thread",
        target: "#coforge:#442",
      },
      messages: [{ id: "m1", sequence: 16, target: "#coforge:#442" }],
      hasOlder: false,
      hasNewer: false,
      modelSeenUpToSeq: 16,
      readPositionAfter: 16,
      ...overrides,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const event = (records: readonly LogRecord[], name: string) =>
  records.find((record) => record.properties.event === name);

test("a recorded task read logs the boundary the server sent, so a cursor that did not move is visible", async () => {
  const recorded: unknown[] = [];
  const { records } = await captureDaemonLogs(async () => {
    await forwardedTaskReadResponse(
      {
        agentId: "agent-1",
        request,
        recordRead: (_agentId, _query, body) => void recorded.push(body),
      },
      page(),
    );
  });
  expect(recorded).toHaveLength(1);
  expect(event(records, "agent.task_read.recorded")?.properties).toEqual({
    event: "agent.task_read.recorded",
    agent_id: "agent-1",
    target: "#coforge:#442",
    model_seen_up_to_seq: 16,
    read_position_after: 16,
    messages: 1,
    unread: true,
  });
  expect(event(records, "agent.task_read.not_recorded")).toBeUndefined();
});

test("a read whose boundary the server left empty records that fact rather than a guessed number", async () => {
  const { records } = await captureDaemonLogs(async () => {
    await forwardedTaskReadResponse(
      { agentId: "agent-1", request, recordRead: () => {} },
      page({ modelSeenUpToSeq: null, readPositionAfter: undefined }),
    );
  });
  expect(event(records, "agent.task_read.recorded")?.properties).toMatchObject({
    model_seen_up_to_seq: null,
    read_position_after: null,
  });
});

test("a body without this Agent's scope still logs the skip, not a record", async () => {
  const { records } = await captureDaemonLogs(async () => {
    await forwardedTaskReadResponse(
      {
        agentId: "agent-1",
        request,
        recordRead: () => {
          throw new Error("must not record");
        },
      },
      page({
        consumptionScope: {
          agentId: "other-agent",
          conversationId: "conversation-1",
          channelType: "thread",
          target: "#coforge:#442",
        },
      }),
    );
  });
  expect(event(records, "agent.task_read.recorded")).toBeUndefined();
  expect(event(records, "agent.task_read.not_recorded")?.properties).toMatchObject({
    agent_id: "agent-1",
    reason: "scope_missing_or_foreign",
    scope_agent_matches: false,
  });
});

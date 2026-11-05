import { expect, test } from "bun:test";
import { noteTurnFinished, noteTurnStarted } from "#src/daemon-runtime/turn-boundaries";
import { captureDaemonLogs } from "./log-capture";

test("a turn's start logs its agent and how the turn was opened", async () => {
  const { records } = await captureDaemonLogs(async () => {
    noteTurnStarted("agent-a", "delivery");
  });
  expect(
    records.find((record) => record.properties.event === "agent.turn.started")?.properties,
  ).toMatchObject({ agent_id: "agent-a", via: "delivery" });
});

test("a turn's end logs its outcome, and the conversation when the turn belongs to one", async () => {
  const { records } = await captureDaemonLogs(async () => {
    noteTurnFinished("agent-a", "completed", "conversation-a");
    noteTurnFinished("agent-a", "failed");
  });
  const finished = records.filter((record) => record.properties.event === "agent.turn.finished");
  expect(finished).toHaveLength(2);
  expect(finished[0]!.properties).toMatchObject({
    agent_id: "agent-a",
    status: "completed",
    conversation_id: "conversation-a",
  });
  expect(finished[1]!.properties).toMatchObject({ agent_id: "agent-a", status: "failed" });
});

import { expect, test } from "bun:test";
import {
  decodeAgentTaskIdleNudgeResponse,
  type AgentTaskIdleNudgeResponse,
} from "@lrm/coforge-sdk/agent";
import { createAgentTaskIdleNudgeHttpClient } from "#src/connection/agent-task-idle-nudge-client";

const request = { freshSession: true };
const keys = { agentApiKey: "sk_agent_key", daemonApiKey: "daemon-key" };
const url = "https://server.example/api/agent/v1/tasks/idle-nudge";

const response = (body: unknown, status = 200) =>
  createAgentTaskIdleNudgeHttpClient(1_000, async () => Response.json(body, { status }));

const nudge: AgentTaskIdleNudgeResponse = {
  send: true,
  items: [
    {
      ref: "#coforge:#12",
      taskNumber: 12,
      channel: "coforge",
      title: "Fix the login page",
      status: "in_progress",
      priority: "high",
      reason: "others_acted",
      why: "someone replied in its conversation",
    },
  ],
  backlog: [{ ref: "#coforge:#15", title: "Rotate the keys" }],
  text: "[Idle task reminder] ...",
};

test("a 200 answers the decoded reminder", async () => {
  await expect(response(nudge).execute({ url, ...keys, request })).resolves.toEqual(nudge);
});

test("a 404 is no route, not an error: the caller retries in an hour", async () => {
  await expect(
    response({ error: "not found" }, 404).execute({ url, ...keys, request }),
  ).resolves.toBeUndefined();
});

test("any other refusal is a transport failure", async () => {
  await expect(
    response({ error: "boom" }, 500).execute({ url, ...keys, request }),
  ).rejects.toThrow();
});

test("a malformed answer is refused before its text can reach the Agent", async () => {
  await expect(
    response({ ...nudge, items: [{ ...nudge.items[0], reason: "invented" }] }).execute({
      url,
      ...keys,
      request,
    }),
  ).rejects.toThrow("invalid Agent task idle-nudge response");
  await expect(
    response({ ...nudge, send: "yes" }).execute({ url, ...keys, request }),
  ).rejects.toThrow("invalid Agent task idle-nudge response");
});

test("the decoder accepts a skip reason and refuses an unknown one", () => {
  expect(
    decodeAgentTaskIdleNudgeResponse({
      send: false,
      reason: "hourly_cap",
      items: [],
      backlog: [],
      text: "",
    }),
  ).toMatchObject({ send: false, reason: "hourly_cap" });
  expect(() =>
    decodeAgentTaskIdleNudgeResponse({
      send: false,
      reason: "later",
      items: [],
      backlog: [],
      text: "",
    }),
  ).toThrow("invalid Agent task idle-nudge response");
});

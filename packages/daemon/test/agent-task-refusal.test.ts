import { expect, test } from "bun:test";
import { taskRefusalError } from "../src/connection/agent-task-refusal";
import { captureDaemonLogs } from "./log-capture";

test("a task 5xx keeps a bounded body snippet in the daemon log", async () => {
  const { result, records } = await captureDaemonLogs(async () =>
    taskRefusalError(new Response("upstream stack trace\nline 2", { status: 502 })).catch(
      (error: unknown) => error,
    ),
  );
  expect(result).toBeInstanceOf(Error);
  const event = records.find(
    (record) => record.properties.event === "agent.http.upstream_5xx_body",
  );
  expect(event?.properties).toMatchObject({
    what: "Agent Task",
    status: 502,
    upstream_body_snippet: "upstream stack trace\nline 2",
  });
});

test("a task 4xx is not a body dump", async () => {
  const { records } = await captureDaemonLogs(async () => {
    await taskRefusalError(new Response("not found", { status: 404 })).catch(() => {});
  });
  expect(records.map((record) => record.properties.event)).not.toContain(
    "agent.http.upstream_5xx_body",
  );
});

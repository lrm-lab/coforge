import { expect, test } from "bun:test";
import type { TaskResult } from "@lrm/coforge-sdk/internal";
import { run } from "../index";
import { CliError, renderCliErrorJson, renderCliErrorText } from "#src/cli-error";

// A held task write is a refusal, not a result: nothing was written, so the CLI must not exit 0 as
// if the task existed. These tests pin that exit and the held context that rides with it.
const transport = (result: TaskResult) => ({
  check: async () => ({ messages: [] }),
  read: async () => undefined,
  send: async () => undefined,
  view: async () => ({ bytes: new Uint8Array() }),
  task: async () => result,
});

const message = (body: string, sequence = 1) => ({
  id: `message-${sequence}`,
  sequence,
  senderKind: "human" as const,
  senderHandle: "ada",
  senderDescription: "",
  target: "#general",
  body,
  createdAt: "now",
  attachments: [],
});

const held = (overrides: Partial<TaskResult>): TaskResult => ({
  tasks: [],
  state: "held",
  ...overrides,
});

const heldError = async (args: readonly string[], result: TaskResult): Promise<CliError> => {
  const error = await run(args, transport(result)).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CliError);
  return error as CliError;
};

test("a held Task write fails with a typed error and keeps the held messages", async () => {
  const error = await heldError(
    ["task", "create", "--target", "#general", "--title", "Ship it"],
    held({ newMessageCount: 1, heldMessages: [message("VISIBLE_CONTEXT")] }),
  );
  expect(error.code).toBe("TASK_REQUEST_HELD");
  expect(error.retryable).toBe(false);
  expect(error.message).toBe("Task request held; no task was written.");
  const rendered = renderCliErrorText(error);
  expect(rendered).toContain("Task request held.");
  expect(rendered).toContain("VISIBLE_CONTEXT");
  expect(rendered).toContain("rerun this command with --anyway");
  expect(rendered).toContain("Error: Task request held; no task was written.");
  expect(rendered).toContain("Code: TASK_REQUEST_HELD");
});

test("a held Task write in --json mode is one error object that carries the held context", async () => {
  const error = await heldError(
    ["task", "create", "--target", "#general", "--title", "Ship it", "--json"],
    held({ newMessageCount: 1, heldMessages: [message("VISIBLE_CONTEXT", 4)] }),
  );
  expect(error.outputMode).toBe("json");
  const parsed = JSON.parse(renderCliErrorJson(error));
  expect(parsed.error.code).toBe("TASK_REQUEST_HELD");
  expect(parsed.error.retryable).toBe(false);
  expect(parsed.details).toMatchObject({ newMessageCount: 1 });
  expect(JSON.stringify(parsed.details)).toContain("VISIBLE_CONTEXT");
});

test("reviewer-isolation held Task output suppresses secret context", async () => {
  const error = await heldError(
    ["task", "claim", "--target", "#general", "--number", "1", "--reviewer-isolation"],
    held({
      freshnessContextMode: "withheld",
      newMessageCount: 2,
      heldMessages: [message("SECRET_SENTINEL")],
    }),
  );
  expect(error.code).toBe("TASK_REQUEST_HELD");
  expect(error.message).toBe("Reviewer-isolation freshness hold: 2 newer messages withheld.");
  expect(renderCliErrorText(error)).not.toContain("SECRET_SENTINEL");
});

test("requested reviewer isolation suppresses held Task context even when the response says inline", async () => {
  const error = await heldError(
    [
      "task",
      "update",
      "--target",
      "#general",
      "--number",
      "1",
      "--status",
      "in_review",
      "--expected-revision",
      "5",
      "--reviewer-isolation",
    ],
    held({
      freshnessContextMode: "inline",
      newMessageCount: 1,
      heldMessages: [message("SECRET_SENTINEL")],
    }),
  );
  expect(error.code).toBe("TASK_REQUEST_HELD");
  expect(error.message).toBe("Reviewer-isolation freshness hold: 1 newer message withheld.");
  expect(renderCliErrorText(error)).not.toContain("SECRET_SENTINEL");
});

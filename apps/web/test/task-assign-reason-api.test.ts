import { expect, test } from "bun:test";
import { AppError } from "#src/lib/app-error";
import { handleAgentTaskPost } from "#src/routes/api/agent/v1/tasks";
import { TASK_ASSIGN_REASON_INVALID } from "#src/server/tasks/task-assign-reason.server";
import { validateTaskCommand } from "#src/server/tasks/task-command-validation.server";
import { agentTaskPrincipal } from "#src/server/tasks/task-principal.server";

/**
 * `task assign --reason` carries one handover line, and the CLI has always refused a blank, wrapped
 * or over-long one. The rules lived only there, so a write straight to the API stored whatever it
 * was given — the notice then showed a paragraph where one line belongs (task #36). The board asks
 * the same question now, and its refusal names which rule was broken.
 */
const principal = agentTaskPrincipal({
  workspaceId: "workspace-1",
  agentId: "agent-1",
});
const assignCommand = {
  operation: "assign",
  idempotencyKey: "0b8a3c1e-5d2f-4a6b-9c7d-1e2f3a4b5c6d",
  conversationId: "1c9b4d2f-6e3a-4b7c-8d9e-2f3a4b5c6d7e",
  number: 7,
  assignee: "@ada",
} as const;

/** The route's board does what the real one does first: refuse a command it cannot store. */
async function post(command: Record<string, unknown>) {
  let received: { reason?: string } | undefined;
  const response = await handleAgentTaskPost(
    new Request("https://server.example/api/agent/v1/tasks", {
      method: "POST",
      body: JSON.stringify(command),
    }),
    principal,
    {
      execute: async (_principal, receivedCommand) => {
        validateTaskCommand(receivedCommand as never);
        received = receivedCommand as { reason?: string };
        return { tasks: [] };
      },
    },
  );
  return { response, received, body: (await response.json()) as { error?: string; code?: string } };
}

test("an API assignment carries a 200-character single line as given", async () => {
  const reason = "x".repeat(200);
  const { response, received } = await post({ ...assignCommand, reason });
  expect(response.status).toBe(200);
  expect(received?.reason).toBe(reason);
});

test("an API assignment refuses a reason longer than the one line may be", async () => {
  const { response, body, received } = await post({ ...assignCommand, reason: "x".repeat(201) });
  expect(response.status).toBe(400);
  expect(body.code).toBe("INVALID_INPUT");
  expect(body.error).toBe("an assignment's reason must be at most 200 characters");
  expect(received).toBeUndefined();
});

test("an API assignment refuses a reason that wraps", async () => {
  const { response, body } = await post({
    ...assignCommand,
    reason: "finish the daemon side first\nand then say so",
  });
  expect(response.status).toBe(400);
  expect(body.error).toBe("an assignment's reason must be a single line");
});

test("an API assignment refuses a reason that says nothing", async () => {
  const { response, body } = await post({ ...assignCommand, reason: "   " });
  expect(response.status).toBe(400);
  expect(body.error).toBe("an assignment's reason must say something");
});

test("only an assignment takes a reason", async () => {
  const { response } = await post({
    ...assignCommand,
    operation: "unassign",
    assignee: undefined,
    reason: "why not",
  });
  expect(response.status).toBe(400);
});

test("the board's own gate names the reason refusal for an Agent to read", () => {
  // The route returns a hint only for the ids written for Agents; this one is.
  try {
    validateTaskCommand({ ...assignCommand, reason: "x".repeat(201) } as never);
    throw new Error("the over-long reason should have been refused");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).errorId).toBe(TASK_ASSIGN_REASON_INVALID);
    expect((error as AppError).hint).toContain("200 characters");
  }
});

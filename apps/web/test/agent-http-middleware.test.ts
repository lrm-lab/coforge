import { expect, test } from "bun:test";
import { decodeAgentApiRefusal } from "@lrm/coforge-sdk/agent";
import { AppError } from "#src/lib/app-error";
import { RequestAuthenticationError } from "#src/server/errors/request-error-handler.server";
import {
  AgentMessageValidationError,
  MESSAGE_NOT_VISIBLE,
} from "#src/server/conversations/agent-message-validation-error.server";
import { MessageRequestInProgressError } from "#src/server/conversations/message-request-idempotency.server";
import { agentErrorResponse, noStore } from "#src/server/agents/agent-http-middleware.server";

const header = "cache-control";

test("noStore adds cache-control: no-store", () => {
  const response = new Response("body", { status: 200 });
  expect(noStore(response).headers.get(header)).toBe("no-store");
});

test("noStore preserves the status, the status text and the other headers", () => {
  const response = new Response("body", {
    status: 201,
    statusText: "Created",
    headers: { "content-type": "application/json", "x-existing": "kept" },
  });

  const copied = noStore(response);

  expect(copied.status).toBe(201);
  expect(copied.statusText).toBe("Created");
  expect(copied.headers.get("content-type")).toBe("application/json");
  expect(copied.headers.get("x-existing")).toBe("kept");
});

test("noStore rebuilds the response rather than mutating the one it was handed", () => {
  const response = new Response("body", { headers: { [header]: "public, max-age=60" } });

  const copied = noStore(response);

  expect(copied.headers.get(header)).toBe("no-store");
  // The caller's response keeps whatever it said: the middleware replaces the field it returns, and a
  // route that set its own value is not silently edited out from under it.
  expect(response.headers.get(header)).toBe("public, max-age=60");
});

test("agent business refusals keep their status and machine-readable code", async () => {
  for (const [error, status, reason, retryable] of [
    [new AppError("ACCESS_DENIED"), 403, "forbidden", false],
    [new AppError("INVALID_INPUT"), 400, "invalid input", false],
    [new AppError("NOT_FOUND"), 404, "not found", false],
    [new AppError("CONFLICT"), 409, "conflict", false],
    [new AppError("TEMPORARILY_UNAVAILABLE"), 503, "temporarily unavailable", true],
  ] as const) {
    const response = agentErrorResponse(error);
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body).toEqual({ error: reason, code: error.code, retryable });
    // The daemon relays a refusal to the Agent only in exactly this shape.
    expect(decodeAgentApiRefusal(body)).toBeDefined();
  }
});

test("an AppError's errorId travels inside the refusal reason", async () => {
  const response = agentErrorResponse(new AppError("CONFLICT", { errorId: "agent-migrating" }));
  expect(response.status).toBe(409);
  const body = await response.json();
  expect(body).toEqual({
    error: "conflict (agent-migrating)",
    code: "CONFLICT",
    retryable: false,
  });
  expect(decodeAgentApiRefusal(body)).toBeDefined();
});

test("a validation failure is a bare-text 400 and an in-progress send a retryable 409", async () => {
  const validation = agentErrorResponse(new AgentMessageValidationError(MESSAGE_NOT_VISIBLE));
  expect(validation.status).toBe(400);
  expect(await validation.text()).toBe(MESSAGE_NOT_VISIBLE);

  const inProgress = agentErrorResponse(new MessageRequestInProgressError());
  expect(inProgress.status).toBe(409);
  const body = await inProgress.json();
  expect(body).toEqual({
    error: "message request is already processing; retry later",
    code: "MESSAGE_REQUEST_IN_PROGRESS",
    retryable: true,
  });
  expect(decodeAgentApiRefusal(body)).toBeDefined();
});

test("agent authentication failures stay 401 while unknown failures are 500", async () => {
  const authentication = agentErrorResponse(new RequestAuthenticationError());
  expect(authentication.status).toBe(401);
  expect(await authentication.text()).toBe("unauthorized");

  const unknown = agentErrorResponse(new Error("database exploded"));
  expect(unknown.status).toBe(500);
  expect(await unknown.json()).toEqual({ error: "internal server error" });
});

test("an AppError's details and hint travel in the refusal, and it still decodes", async () => {
  const details = { taskNumber: 7, holder: "atlas", holderName: "Atlas Bot" };
  const response = agentErrorResponse(
    new AppError("CONFLICT", {
      errorId: "source_message_taken",
      hint: "Task #7 is held by Atlas Bot.",
      details,
    }),
  );
  expect(response.status).toBe(409);
  const body = await response.json();
  expect(body).toEqual({
    error: "conflict (source_message_taken): Task #7 is held by Atlas Bot.",
    code: "CONFLICT",
    retryable: false,
    details,
  });
  expect(decodeAgentApiRefusal(body)).toEqual(body);
});

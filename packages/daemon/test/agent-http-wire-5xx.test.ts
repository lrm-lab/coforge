import { expect, test } from "bun:test";
import { assertAgentResponseOk } from "#src/connection/agent-http-wire";
import { AgentTransportError } from "#src/connection/agent-transport-error";

const failure = (response: Response) =>
  assertAgentResponseOk(response, "agent send").then(
    () => Promise.reject(new Error("the response was expected to fail")),
    (thrown: unknown) => thrown as AgentTransportError,
  );

test("a 5xx that names its reason carries it on the transport failure", async () => {
  const error = await failure(
    Response.json(
      { error: "the database is read-only right now", code: "DATABASE_READ_ONLY", retryable: true },
      { status: 503 },
    ),
  );
  expect(error).toBeInstanceOf(AgentTransportError);
  expect(error).toMatchObject({
    failureClass: "upstream_http_response",
    upstreamStatus: 503,
    upstreamError: "the database is read-only right now",
    upstreamCode: "DATABASE_READ_ONLY",
    upstreamRetryable: true,
  });
});

test("a 5xx body outside the refusal shape stays opaque", async () => {
  for (const body of [
    "Bad Gateway",
    JSON.stringify({ trace: "at handler" }),
    JSON.stringify({ error: "" }),
  ]) {
    const error = await failure(new Response(body, { status: 502 }));
    expect(error).toBeInstanceOf(AgentTransportError);
    expect(error.failureClass).toBe("upstream_http_response");
    expect(error.upstreamError).toBeUndefined();
    expect(error.upstreamCode).toBeUndefined();
  }
});

test("a 5xx keeps the reason but drops a code that is not stable", async () => {
  const error = await failure(
    Response.json(
      { error: "upstream dependency failed", code: "not a stable code" },
      { status: 500 },
    ),
  );
  expect(error.upstreamError).toBe("upstream dependency failed");
  expect(error.upstreamCode).toBeUndefined();
});

import { expect, test } from "bun:test";
import { getAgentJson, sendAgentJson, type HttpFetch } from "#src/connection/agent-http-wire";
import { AgentTransportError } from "#src/connection/agent-transport-error";

// A connection reset before the server answered, or a 5xx from the proxy in front of it, is worth
// exactly one more attempt when repeating the request cannot double its effect: every read, and a
// write that already carries the idempotency key the server settles by. Anything else keeps the
// single attempt it had (task #24, Raft 1.0.69 item 3).

const keys = {
  url: "https://server.example/api/agent/v1/route",
  agentApiKey: "sk_agent_test",
  daemonApiKey: "daemon-token",
};

/** Answers in the order given: an Error throws, a number is a status with `body` for its JSON. */
function sequence(answers: readonly (number | Error)[], body: unknown = { ok: true }) {
  const calls: { method?: string; body?: string }[] = [];
  const fetchImpl: HttpFetch = async (_input, init) => {
    calls.push({ method: init?.method, body: init?.body as string | undefined });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    if (answer instanceof Error) throw answer;
    return Response.json(body, { status: answer });
  };
  return { calls, fetchImpl };
}

test("a read whose connection resets before the answer is issued once more", async () => {
  const { calls, fetchImpl } = sequence([new Error("ECONNRESET"), 200], { tasks: [] });
  const result = await getAgentJson<{ tasks: unknown[] }>(fetchImpl, {
    ...keys,
    query: {},
    what: "task list",
  });
  expect(result).toEqual({ tasks: [] });
  expect(calls).toHaveLength(2);
  expect(calls.every((call) => call.method === "GET")).toBe(true);
});

test("a read that meets a 5xx is issued once more", async () => {
  const { calls, fetchImpl } = sequence([502, 200], { tasks: [] });
  const result = await getAgentJson<{ tasks: unknown[] }>(fetchImpl, {
    ...keys,
    query: {},
    what: "task list",
  });
  expect(result).toEqual({ tasks: [] });
  expect(calls).toHaveLength(2);
});

test("a read answered by the second attempt's 5xx stops there", async () => {
  const { calls, fetchImpl } = sequence([500, 503], { error: "upstream down" });
  const attempt = getAgentJson<unknown>(fetchImpl, { ...keys, query: {}, what: "task list" });
  await expect(attempt).rejects.toThrow();
  expect(calls).toHaveLength(2);
});

test("a 4xx is never repeated", async () => {
  const { calls, fetchImpl } = sequence([409, 200], { error: "conflict", code: "CONFLICT" });
  const attempt = getAgentJson<unknown>(fetchImpl, { ...keys, query: {}, what: "task list" });
  await expect(attempt).rejects.toThrow();
  expect(calls).toHaveLength(1);
});

test("a write carrying an idempotency key keeps one attempt here: its own settlement repeats it", async () => {
  const { calls, fetchImpl } = sequence([new Error("ECONNRESET"), 200], { ok: true });
  const attempt = sendAgentJson<unknown>(fetchImpl, {
    ...keys,
    method: "POST",
    body: { idempotencyKey: "key-1", content: "hi" },
    what: "message send",
  });
  await expect(attempt).rejects.toThrow();
  // One outage must not cost four attempts: the send reconciles and replays under this key itself.
  expect(calls).toHaveLength(1);
});

test("a write with no idempotency key keeps its single attempt", async () => {
  const { calls, fetchImpl } = sequence([new Error("ECONNRESET"), 200], { ok: true });
  const attempt = sendAgentJson<unknown>(fetchImpl, {
    ...keys,
    method: "POST",
    body: { title: "a task" },
    what: "task create",
  });
  await expect(attempt).rejects.toThrow();
  expect(calls).toHaveLength(1);
});

test("a reset that repeats is reported as the transport failure it is", async () => {
  const { calls, fetchImpl } = sequence([new Error("ECONNRESET"), new Error("ECONNRESET")]);
  const attempt = getAgentJson<unknown>(fetchImpl, { ...keys, query: {}, what: "task list" });
  await expect(attempt).rejects.toBeInstanceOf(AgentTransportError);
  expect(calls).toHaveLength(2);
});

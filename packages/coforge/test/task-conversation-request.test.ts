import { afterEach, expect, spyOn, test } from "bun:test";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { CliError } from "../src/cli-error";
import { connectLocal } from "../src/local-client";
import { taskConversationRequest } from "../src/task-conversation-request";

afterEach(() => {
  spyOn(globalThis, "fetch").mockRestore();
});

const context = `sfp_${"a".repeat(43)}`;
const proxyUrl = "http://127.0.0.1:1";
const proxyEndpoint = (path: string) => new URL(path, proxyUrl);
const routes = agentApiRoutes.local.taskConversations;

type Answer = Response | Error;
function answers(...queue: Answer[]) {
  return spyOn(globalThis, "fetch").mockImplementation((async () => {
    const next = queue.shift()!;
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof globalThis.fetch);
}
const send = (request: Parameters<typeof taskConversationRequest>[3]) =>
  taskConversationRequest(proxyEndpoint, context, proxyUrl, request);

async function failure(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    return error as CliError;
  }
  throw new Error("expected a failure");
}

test("a GET carries its query, a POST its JSON body, both the Agent's context", async () => {
  const fetch = answers(Response.json({ tasks: [] }), Response.json({ ok: true }));
  const query = { channel: "#general", task_number: "7", limit: "5" };
  expect(await send({ route: "view", query })).toEqual({ tasks: [] });
  const body = { channel: "#general", task_number: 7 };
  await send({ route: "follow", body });
  const [view, follow] = fetch.mock.calls as [[URL, RequestInit], [URL, RequestInit]];
  expect(String(view[0])).toBe(
    `${proxyUrl}${routes.view.path}?channel=%23general&task_number=7&limit=5`,
  );
  expect(view[1].method).toBe("GET");
  expect(view[1].body).toBeUndefined();
  expect(new Headers(view[1].headers).get("authorization")).toBe(`Bearer ${context}`);
  expect(String(follow[0])).toBe(`${proxyUrl}${routes.follow.path}`);
  expect(follow[1].method).toBe("POST");
  expect(follow[1].body).toBe(JSON.stringify(body));
  expect(new Headers(follow[1].headers).get("content-type")).toBe("application/json");
});

test("a refusal keeps the server's text; not found is NOT_FOUND, the rest the command's own code", async () => {
  answers(
    Response.json({ error: "not found" }, { status: 404 }),
    Response.json({ error: "invalid input" }, { status: 400 }),
    Response.json({ error: "forbidden" }, { status: 403 }),
    Response.json({ error: "Not on.", code: "task_conversations_off" }, { status: 404 }),
    new Response("nope", { status: 400 }),
  );
  const request = { route: "view" as const, query: { channel: "#a", task_number: "1" } };
  const missing = await failure(send(request));
  expect([missing.code, missing.message, missing.retryable]).toEqual([
    "NOT_FOUND",
    "not found",
    false,
  ]);
  const invalid = await failure(send(request));
  expect([invalid.code, invalid.message]).toEqual(["VIEW_FAILED", "invalid input"]);
  const forbidden = await failure(send({ route: "unfollow", body: {} }));
  expect([forbidden.code, forbidden.message]).toEqual(["FOLLOW_FAILED", "forbidden"]);
  const off = await failure(send({ route: "following" }));
  expect([off.code, off.message]).toEqual(["TASK_CONVERSATIONS_OFF", "Not on."]);
  const bare = await failure(send({ route: "reply", body: {} }));
  expect([bare.code, bare.message]).toEqual(["REPLY_FAILED", "HTTP 400"]);
});

test("a 5xx is SERVER_5XX and a transport failure the command's code, both retryable", async () => {
  answers(Response.json({ error: "boom" }, { status: 503 }), new TypeError("fetch failed"));
  const server = await failure(send({ route: "reply", body: {} }));
  expect([server.code, server.retryable]).toEqual(["SERVER_5XX", true]);
  const network = await failure(send({ route: "following" }));
  expect([network.code, network.retryable]).toEqual(["LIST_FAILED", true]);
  expect(network.message).toBe("agent proxy request failed (network or timeout)");
});

test("an answer that is not JSON is INVALID_JSON_RESPONSE", async () => {
  answers(new Response("<html>", { status: 200 }));
  expect((await failure(send({ route: "following" }))).code).toBe("INVALID_JSON_RESPONSE");
});

test("nothing is sent without an agent context or proxy", async () => {
  const fetch = answers();
  const noContext = await failure(
    taskConversationRequest(proxyEndpoint, "", proxyUrl, { route: "following" }),
  );
  expect([noContext.code, noContext.message]).toEqual([
    "LIST_FAILED",
    "coforge agent context is not configured",
  ]);
  expect(fetch).not.toHaveBeenCalled();
});

test("the local client sends a task conversation request through the proxy", async () => {
  const fetch = answers(Response.json({ tasks: [] }));
  const client = connectLocal("", context, `${proxyUrl}${agentApiRoutes.local.messages.path}`);
  expect(await client.taskConversation({ route: "following" })).toEqual({ tasks: [] });
  expect(String(fetch.mock.calls[0]![0])).toBe(`${proxyUrl}${routes.following.path}`);
});

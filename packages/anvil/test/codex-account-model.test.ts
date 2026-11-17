import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RuntimeModelNotFoundError, type AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { scenarioProvider, waitForEvent } from "./codex-scenarios";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "coforge-codex-account-model-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** The launch config of an Agent that chose `model` itself. */
const chosen = (model: string) => ({ provider: "codex" as const, model, reasoning: "" });

type Request = { method?: string; params?: Record<string, unknown> };

async function requests(): Promise<Request[]> {
  const log = await readFile(join(directory, "requests.jsonl"), "utf8");
  return log
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Request);
}

/** The `turn/start` requests of one turn sent through a session opened with these arguments. */
async function turnRequests(
  args: readonly string[],
  options: { model?: string; sessionId?: string } = {},
): Promise<Request[]> {
  const session = await scenarioProvider(
    ...args,
    `log=${join(directory, "requests.jsonl")}`,
  ).createAgentSession({
    agentWorkspaceDirectory: directory,
    instructions: "Test.",
    sessionId: options.sessionId,
    ...(options.model ? { runtime: chosen(options.model) } : {}),
  });
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.sendMessage("hello");
    await waitForEvent(events, "completed");
  } finally {
    await session.dispose();
  }
  return (await requests()).filter((request) => request.method === "turn/start");
}

for (const sessionId of [undefined, "thread-1"]) {
  test(`a ${sessionId ? "resumed" : "new"} thread whose default model the ChatGPT account cannot use runs on the account's default`, async () => {
    const [turn] = await turnRequests(["scenario=chatgpt"], { sessionId });
    // The listed default, not the hidden model on the first page that also claims it.
    expect(turn?.params?.model).toBe("gpt-account");
  });
}

test("a configured model the ChatGPT account can use is kept", async () => {
  const [turn] = await turnRequests(["scenario=chatgpt", "config-model=gpt-other"]);
  expect(turn?.params).not.toHaveProperty("model");
});

test("a hidden model the account still accepts is kept", async () => {
  const [turn] = await turnRequests(["scenario=chatgpt", "config-model=gpt-hidden"]);
  expect(turn?.params).not.toHaveProperty("model");
});

test("an API-key sign-in is left to Codex: its models are not the account list", async () => {
  const [turn] = await turnRequests(["scenario=api-key"]);
  expect(turn?.params).not.toHaveProperty("model");
  expect((await requests()).some((request) => request.method === "model/list")).toBe(false);
});

test("a model the Agent chose is never replaced: the launch fails as model_not_found", async () => {
  const launch = scenarioProvider(
    "scenario=chatgpt",
    `log=${join(directory, "requests.jsonl")}`,
  ).createAgentSession({
    agentWorkspaceDirectory: directory,
    instructions: "Test.",
    runtime: chosen("gpt-6.1-sol"),
  });
  const error = await launch.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(RuntimeModelNotFoundError);
  expect(error).toMatchObject({ code: "model_not_found", model: "gpt-6.1-sol" });
});

test("a model the Agent chose that the account can use starts with no override", async () => {
  const [turn] = await turnRequests(["scenario=chatgpt"], { model: "gpt-other" });
  expect(turn?.params).not.toHaveProperty("model");
});

test("a turn Codex fails as modelNotFound reports model_not_found", async () => {
  const session = await scenarioProvider().createAgentSession({
    agentWorkspaceDirectory: directory,
    instructions: "Test.",
  });
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.sendMessage("model-not-found");
    await waitForEvent(events, "completed");
  } finally {
    await session.dispose();
  }
  expect(events.filter((event) => event.type === "error")).toEqual([
    expect.objectContaining({ providerErrorClass: "model_not_found" }),
  ]);
});

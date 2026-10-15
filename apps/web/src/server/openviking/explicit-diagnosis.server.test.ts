import { expect, test } from "bun:test";
import { createOpenVikingExplicitDiagnosis } from "./explicit-diagnosis.server";
import { createOpenVikingRuntimeClient } from "./runtime-client.server";

test("starts with caller-owned causal evidence and polls without appending or rebuilding", async () => {
  let started = false;
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const run = createOpenVikingExplicitDiagnosis({
    async identity() {
      return {
        accountId: "account",
        userId: "agent:task",
        role: "user",
        authorization: "Bearer test",
      };
    },
    runtime: createOpenVikingRuntimeClient({
      baseUrl: "http://ov.internal",
      async fetchImpl(url, init) {
        const path = new URL(String(url)).pathname;
        calls.push({
          path,
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        expect(new Headers(init?.headers).get("x-openviking-user")).toBe("agent:task");
        if (init?.method === "GET" && !started) return new Response(null, { status: 404 });
        if (path.endsWith("/diagnosis")) started = true;
        return Response.json({ status: "ok", result: { status: "running" } });
      },
    }),
  });
  const scope = {
    requestId: "request",
    conversationId: "group",
    targetAgentId: "task",
    question: "diagnose",
    messages: [
      {
        role: "assistant" as const,
        content: "failed search",
        sourceMessageIds: ["q"],
        createdAt: "2026-10-15T00:00:00Z",
        peerId: "coforge__task",
      },
    ],
  };
  expect(await run("workspace", scope)).toMatchObject({ status: "running" });
  expect(calls[1]).toMatchObject({
    body: { skill_trajectory_mode: "causal", auto_commit_policy: null },
  });
  expect(calls[2]).toMatchObject({
    body: { messages: [{ source_message_ids: ["q"], peer_id: "coforge__task" }] },
  });
  const before = calls.length;
  await run("workspace", scope);
  expect(calls.slice(before).map((call) => call.method)).toEqual(["GET"]);
});

test("ACL refusal during polling never recreates a session or starts construction", async () => {
  let calls = 0;
  const run = createOpenVikingExplicitDiagnosis({
    async identity() {
      return { accountId: "account", userId: "task", role: "user", authorization: "Bearer test" };
    },
    runtime: createOpenVikingRuntimeClient({
      baseUrl: "http://ov.internal",
      async fetchImpl() {
        calls++;
        return new Response(null, { status: 403 });
      },
    }),
  });
  await expect(
    run("workspace", {
      requestId: "q",
      conversationId: "c",
      targetAgentId: "t",
      question: "q",
      messages: [],
    }),
  ).rejects.toThrow("diagnosis_runtime_refused");
  expect(calls).toBe(1);
});

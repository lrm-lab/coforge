import { piProvider } from "./fixtures/pi-host";
import { expect, jest, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent, AgentSession } from "@lrm/coforge-anvil";
import { activityHarness } from "./fixtures/activity-runtime";
import { AgentStartup } from "#src/agent-runtime/agent-startup";

function completion(delta: Record<string, unknown>, finishReason: string) {
  return new Response(
    `data: ${JSON.stringify({ id: "wait-fixture", object: "chat.completion.chunk", created: 1, model: "custom", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("announcing a model request does not claim startup readiness or answer an input", () => {
  const startup = new AgentStartup(() => {});
  try {
    startup.observe({
      type: "activity",
      activity: {
        detailKind: "model_request_started",
        level: "info",
        detail: "Waiting for model response",
        observedAtMs: Date.now(),
      },
    });
    expect(startup.waiting).toBe(true);
    expect(startup.responses).toBe(0);
    expect(startup.endsLaunch(new Error("request rejected"), 0)).toBe(true);
    startup.observe({ type: "text-delta", text: "Ready" });
    expect(startup.waiting).toBe(false);
    expect(startup.responses).toBe(1);
  } finally {
    startup.dispose();
  }
});

test("Pi announces each model request before its response, including after a completed tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-pi-model-wait-"));
  const arrived = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const responses = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()];
  let request = 0;
  let session: AgentSession | undefined;
  let run: Promise<void> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      const index = request++;
      if (!responses[index]) return new Response("unexpected request", { status: 400 });
      arrived[index]!.resolve();
      return responses[index]!.promise;
    },
  });
  try {
    const agentDir = join(root, "host");
    const workspace = join(root, "workspace");
    await mkdir(agentDir);
    await mkdir(workspace);
    await Bun.write(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
    await Bun.write(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          openai: {
            baseUrl: `${server.url}v1`,
            models: [{ id: "custom", name: "Custom", api: "openai-completions" }],
          },
        },
      }),
    );
    session = await piProvider().createAgentSession({
      agentWorkspaceDirectory: workspace,
      instructions: "Test Agent instructions.",
      environment: { PI_CODING_AGENT_DIR: agentDir, OPENAI_API_KEY: "fixture-key" },
      runtime: { provider: "pi", modelProvider: "openai", model: "custom", reasoning: "" },
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    session.subscribe((event) => {
      if (event.type === "activity" && event.activity.detailKind === "model_request_started")
        throw new Error("Activity observer unavailable");
    });
    const waiting = () =>
      events.filter(
        (event) =>
          event.type === "activity" && event.activity.detailKind === "model_request_started",
      );
    run = session.sendMessage("Run printf ready, then finish.");
    await Promise.race([arrived[0]!.promise, run]);
    expect(waiting()).toHaveLength(1);
    expect(events.some((event) => event.type === "text-delta")).toBe(false);
    responses[0]!.resolve(
      completion(
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "tool-1",
              type: "function",
              function: { name: "bash", arguments: JSON.stringify({ command: "printf ready" }) },
            },
          ],
        },
        "tool_calls",
      ),
    );
    await Promise.race([arrived[1]!.promise, run]);
    expect(waiting()).toHaveLength(2);
    const endIndex = events.findIndex((event) => event.type === "tool-end");
    expect(endIndex).toBeGreaterThan(-1);
    expect(events.slice(endIndex + 1)).toContainEqual(
      expect.objectContaining({
        type: "activity",
        activity: expect.objectContaining({ detailKind: "model_request_started" }),
      }),
    );
    responses[1]!.resolve(completion({ role: "assistant", content: "Done" }, "stop"));
    await run;
    expect(events).toContainEqual({ type: "text-delta", text: "Done" });
    expect(events.at(-1)).toEqual({ type: "completed", status: "completed" });
    expect(request).toBe(2);
  } finally {
    for (const response of responses)
      response.resolve(completion({ role: "assistant", content: "cleanup" }, "stop"));
    await run?.catch(() => {});
    await session?.dispose();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("the daemon preserves model waiting through heartbeats until output or settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-model-wait-heartbeat-"));
  const { runtime, activities, emitEvent } = await activityHarness({
    workspaceRoot: root,
    workspaceId: "workspace-a",
    computerId: "computer-a",
  });
  jest.useFakeTimers();
  try {
    emitEvent({ type: "tool-end", id: "previous-tool", isError: false });
    emitEvent({
      type: "activity",
      activity: {
        detailKind: "model_request_started",
        level: "info",
        detail: "Waiting for model response",
        observedAtMs: Date.now(),
      },
    });
    expect(activities.at(-1)).toMatchObject({
      detailKind: "model_request_started",
      detail: "Waiting for model response",
    });
    const waiting = runtime.busyAgents();
    jest.advanceTimersByTime(60_000);
    expect(activities.at(-1)).toMatchObject({
      detailKind: "model_request_started",
      isHeartbeat: true,
    });
    expect(runtime.busyAgents()).toEqual(waiting);
    emitEvent({ type: "text-delta", text: "Done" });
    expect(activities.at(-1)?.detailKind).toBe("model_response_started");
    emitEvent({ type: "completed", status: "completed" });
    expect(activities.at(-1)?.detailKind).toBe("idle");
    expect(runtime.busyAgents()).toEqual([]);
  } finally {
    jest.useRealTimers();
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

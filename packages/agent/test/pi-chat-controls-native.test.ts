import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiChatRuntime, listPiChatModels } from "#src/pi-chat/runtime";

test("native steering arrives at a tool boundary, follow-up waits for completion, and model selection stays in this session", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "pi-chat-controls-"));
  const previousOffline = Bun.env.PI_OFFLINE;
  const previousNoProxy = Bun.env.NO_PROXY;
  const toolStarted = Promise.withResolvers<void>();
  const requests: { model: string; messages: { role: string; content: unknown }[] }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as (typeof requests)[number];
      requests.push(body);
      const first = requests.length === 1;
      const delta = first
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "step-one",
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({
                    command: "sleep 0.3; printf TOOL_BOUNDARY",
                    timeout: 3,
                  }),
                },
              },
            ],
          }
        : {
            role: "assistant",
            content: requests.length === 2 ? "STEER_APPLIED" : "FOLLOWUP_APPLIED",
          };
      return new Response(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  let runtime: Awaited<ReturnType<typeof createPiChatRuntime>> | undefined;
  try {
    Bun.env.PI_OFFLINE = "1";
    Bun.env.NO_PROXY = "*";
    const agentDir = join(root, "agent"),
      cwd = join(root, "workspace");
    await mkdir(agentDir);
    await mkdir(cwd);
    await Bun.write(
      join(agentDir, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "private-fixture-key" } }),
    );
    await Bun.write(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          openai: {
            baseUrl: `${server.url}v1`,
            models: ["first", "other"].map((id) => ({ id, name: id, api: "openai-completions" })),
          },
        },
      }),
    );
    await Bun.write(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "openai",
        defaultModel: "first",
        retry: { enabled: false },
      }),
    );
    const models = await listPiChatModels(cwd, agentDir);
    expect(models.map((model) => model.id)).toContain("other");
    expect(JSON.stringify(models)).not.toContain("private-fixture-key");
    runtime = await createPiChatRuntime(cwd, undefined, agentDir, (update) => {
      if (update.messages?.some((message) => message.id === "running:step-one"))
        toolStarted.resolve();
    });
    const running = runtime.prompt("Run the tool then finish this task.");
    await toolStarted.promise;
    await runtime.enqueue!("STEER_NOW", "steer");
    await runtime.enqueue!("AFTER_DONE", "followUp");
    expect(runtime.queue!()).toEqual({ steering: ["STEER_NOW"], followUp: ["AFTER_DONE"] });
    await running;
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[1]?.messages)).toContain("STEER_NOW");
    expect(JSON.stringify(requests[1]?.messages)).toContain("TOOL_BOUNDARY");
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("AFTER_DONE");
    expect(JSON.stringify(requests[2]?.messages)).toContain("AFTER_DONE");
    expect(runtime.queue!()).toEqual({ steering: [], followUp: [] });
    const id = runtime.id;
    await runtime.dispose();
    runtime = await createPiChatRuntime(cwd, id, agentDir, undefined, {
      provider: "openai",
      id: "other",
    });
    await runtime.prompt("Use the selected model.");
    expect(requests.at(-1)?.model).toBe("other");
    expect(JSON.parse(await Bun.file(join(agentDir, "settings.json")).text()).defaultModel).toBe(
      "first",
    );
    await runtime.dispose();
    runtime = await createPiChatRuntime(cwd, id, agentDir);
    expect(runtime.model()).toBe("openai/other");
  } finally {
    await runtime?.dispose();
    server.stop(true);
    if (previousOffline === undefined) delete Bun.env.PI_OFFLINE;
    else Bun.env.PI_OFFLINE = previousOffline;
    if (previousNoProxy === undefined) delete Bun.env.NO_PROXY;
    else Bun.env.NO_PROXY = previousNoProxy;
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

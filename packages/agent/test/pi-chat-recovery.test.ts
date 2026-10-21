import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiChatRuntime } from "#src/pi-chat/runtime";
import { API_KEY_ENV_BY_PROVIDER } from "#src/runtime-provider";

test("an empty native session survives failed preflight and resumes after credentials are repaired", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "pi-chat-recovery-"));
  const previousOffline = Bun.env.PI_OFFLINE;
  const previousNoProxy = Bun.env.NO_PROXY;
  const credentials = Object.fromEntries(
    Object.values(API_KEY_ENV_BY_PROVIDER).map((key) => [key, Bun.env[key]]),
  );
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls++;
      const body = await request.json();
      expect(
        body.messages.some((message: { content: unknown }) =>
          JSON.stringify(message.content).includes("failed prompt"),
        ),
      ).toBe(false);
      return new Response(
        `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "recovered" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  let runtime: Awaited<ReturnType<typeof createPiChatRuntime>> | undefined;
  try {
    Bun.env.PI_OFFLINE = "1";
    Bun.env.NO_PROXY = "*";
    for (const key of Object.keys(credentials)) delete Bun.env[key];
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    await mkdir(cwd);
    await mkdir(agentDir);
    await Bun.write(join(agentDir, "auth.json"), "{}");
    await Bun.write(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          openai: {
            baseUrl: `${server.url}v1`,
            models: [{ id: "custom", api: "openai-completions" }],
          },
        },
      }),
    );
    await Bun.write(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "openai",
        defaultModel: "custom",
        retry: { enabled: false },
      }),
    );
    runtime = await createPiChatRuntime(cwd, undefined, agentDir);
    const id = runtime.id;
    await expect(runtime.prompt("failed prompt")).rejects.toThrow();
    expect(calls).toBe(0);
    await runtime.dispose();
    runtime = undefined;
    await Bun.write(
      join(agentDir, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "fixture-key" } }),
    );
    runtime = await createPiChatRuntime(cwd, id, agentDir);
    expect(runtime.id).toBe(id);
    expect(runtime.messages()).toEqual([]);
    await runtime.prompt("new prompt");
    expect(runtime.messages().at(-1)?.text).toBe("recovered");
    expect(calls).toBe(1);
  } finally {
    await runtime?.dispose();
    server.stop(true);
    if (previousOffline === undefined) delete Bun.env.PI_OFFLINE;
    else Bun.env.PI_OFFLINE = previousOffline;
    if (previousNoProxy === undefined) delete Bun.env.NO_PROXY;
    else Bun.env.NO_PROXY = previousNoProxy;
    for (const [key, value] of Object.entries(credentials)) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

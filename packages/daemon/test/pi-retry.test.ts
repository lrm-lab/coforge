import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent, AgentSession } from "#src/code-agent/contract";
import { PiProvider } from "#src/code-agent/pi/provider";

const TEST_AGENT_INSTRUCTIONS = "Test Agent instructions.";

function completionStream(delta: Record<string, unknown>, finishReason: string | null) {
  return new Response(
    [
      `data: ${JSON.stringify({ id: crypto.randomUUID(), object: "chat.completion.chunk", created: 1, model: "custom", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function writeOpenAiHost(agentDir: string, baseUrl: string) {
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await Bun.write(join(agentDir, "auth.json"), JSON.stringify({ openai: "host-key" }));
  await Bun.write(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        openai: {
          baseUrl,
          models: [{ id: "custom", name: "Custom", api: "openai-completions" }],
        },
      },
    }),
  );
}

function piRuntime(agentDir: string) {
  return {
    environment: { PI_CODING_AGENT_DIR: agentDir },
    runtime: {
      provider: "pi" as const,
      modelProvider: "openai",
      model: "custom",
      reasoning: "",
      providerConfig: { kind: "coforge" as const, providerId: "openai", apiKey: "agent-key" },
    },
  };
}

// Preserve the embedded-session budget of pi-agent-adapter.test.ts when moving this case.
test("embedded Pi reports a recovered retry as completed without a terminal error", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-pi-retry-"));
  let server: ReturnType<typeof Bun.serve> | undefined;
  let session: AgentSession | undefined;
  try {
    const workspace = join(root, "workspace");
    const agentDir = join(root, "host-pi-agent");
    await mkdir(workspace);
    let requests = 0;
    server = Bun.serve({
      port: 0,
      fetch() {
        requests += 1;
        if (requests === 1)
          return new Response(JSON.stringify({ error: { message: "server_busy" } }), {
            status: 400,
          });
        return completionStream({ role: "assistant", content: "recovered" }, "stop");
      },
    });
    await writeOpenAiHost(agentDir, `${server.url}v1`);
    await Bun.write(
      join(agentDir, "settings.json"),
      JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } }),
    );
    session = await new PiProvider().createAgentSession({
      agentWorkspaceDirectory: workspace,
      instructions: TEST_AGENT_INSTRUCTIONS,
      ...piRuntime(agentDir),
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.sendMessage("hello");
    expect(requests).toBe(2);
    expect(events.filter((event) => event.type === "reconnecting")).toEqual([
      {
        type: "reconnecting",
        attempt: 1,
        maxAttempts: 1,
        delayMs: 1,
        message: expect.stringContaining("server_busy"),
      },
    ]);
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(events.filter((event) => event.type === "completed")).toEqual([
      { type: "completed", status: "completed" },
    ]);
    expect(events).toContainEqual({ type: "text-delta", text: "recovered" });
  } finally {
    try {
      await session?.dispose();
    } finally {
      server?.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  }
}, 30_000);

import { piProvider } from "./fixtures/pi-host";
import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent, AgentSession } from "@lrm/coforge-anvil";

// An embedded Pi session runs in-process; see pi-agent-adapter.test.ts for why its tests carry a
// larger budget than bun's default.
setDefaultTimeout(30_000);

const fragments = [
  '{"command": "PATH=/nonexistent coforge message send --tar',
  'get #general --content hi"}',
];

/** An OpenAI chat-completions stream whose one tool call arrives as separate argument chunks. */
function toolCallStream(argumentChunks: readonly string[]) {
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    `data: ${JSON.stringify({ id: "chunk", object: "chat.completion.chunk", created: 1, model: "custom", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
  const call = (args: string, extra: Record<string, unknown> = {}) => ({
    role: "assistant",
    tool_calls: [
      {
        index: 0,
        ...extra,
        function: { ...("name" in extra ? { name: "bash" } : {}), arguments: args },
      },
    ],
  });
  return new Response(
    [
      chunk(call("", { id: "call_send", type: "function", name: "bash" })),
      ...argumentChunks.map((args) => chunk(call(args))),
      chunk({}, "tool_calls"),
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("embedded Pi reports the Agent's send target while the call's arguments stream", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-pi-reply-intent-"));
  let session: AgentSession | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const workspace = join(root, "workspace");
    const agentDir = join(root, "host-pi-agent");
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await mkdir(workspace);
    let requests = 0;
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests += 1;
        return requests === 1
          ? toolCallStream(fragments)
          : new Response(
              `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "custom", choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            );
      },
    });
    await Bun.write(join(agentDir, "auth.json"), JSON.stringify({ openai: "host-key" }));
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
      environment: { PI_CODING_AGENT_DIR: agentDir },
      runtime: {
        provider: "pi" as const,
        modelProvider: "openai",
        model: "custom",
        reasoning: "",
        providerConfig: { kind: "coforge" as const, providerId: "openai", apiKey: "agent-key" },
      },
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.sendMessage("tell them");
    const relevant = events.filter(
      (event) => event.type === "reply-intent" || event.type === "tool-start",
    );
    expect(relevant.map((event) => event.type)).toEqual(["reply-intent", "tool-start"]);
    expect(relevant[0]).toEqual({ type: "reply-intent", id: "call_send", target: "#general" });
    expect(relevant[1]).toMatchObject({ type: "tool-start", id: "call_send", name: "bash" });
  } finally {
    try {
      await session?.dispose();
    } finally {
      server?.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  }
});

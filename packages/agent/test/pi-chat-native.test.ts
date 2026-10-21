import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiChatRuntime } from "#src/pi-chat/runtime";
import { FilePiChatStore } from "#src/pi-chat/storage";
import { piChatResultSchema } from "@lrm/coforge-sdk/internal/pi-chat";

test("native Pi streams a tool call and preserves full tool output and reply after reopening", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "pi-chat-native-"));
  const previousOffline = Bun.env.PI_OFFLINE;
  const previousNoProxy = Bun.env.NO_PROXY;
  const reply = "Complete answer ".repeat(700);
  const source = "complete-file-content ".repeat(350);
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/v1/chat/completions");
      calls++;
      const delta =
        calls <= 2
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: calls === 1 ? "call_read" : "call_edit",
                  type: "function",
                  function:
                    calls === 1
                      ? { name: "read", arguments: JSON.stringify({ path: "fixture.txt" }) }
                      : {
                          name: "edit",
                          arguments: JSON.stringify({
                            path: "fixture.txt",
                            edits: [{ oldText: source, newText: "edited content\n" }],
                          }),
                        },
                },
              ],
            }
          : { role: "assistant", content: reply };
      return new Response(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "custom", choices: [{ index: 0, delta, finish_reason: calls <= 2 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  let runtime: Awaited<ReturnType<typeof createPiChatRuntime>> | undefined;
  try {
    Bun.env.PI_OFFLINE = "1";
    Bun.env.NO_PROXY = "*";
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    await mkdir(cwd);
    await mkdir(agentDir);
    await Bun.write(join(cwd, "fixture.txt"), source);
    await Bun.write(
      join(agentDir, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "fixture-key" } }),
    );
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
    await Bun.write(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "openai",
        defaultModel: "custom",
        retry: { enabled: false },
      }),
    );
    runtime = await createPiChatRuntime(cwd, undefined, agentDir);
    await runtime.prompt("Read fixture.txt, then answer.");
    const messages = runtime.messages();
    expect(messages.find((message) => message.role === "tool")?.text).toContain(source);
    expect(typeof messages.find((message) => message.role === "tool")?.durationMs).toBe("number");
    expect(messages.at(-1)?.text).toBe(reply);
    const edit = messages.find((message) => message.toolName === "edit");
    expect(JSON.parse(edit?.details ?? "null")).toMatchObject({
      diff: expect.stringContaining("edited content"),
      patch: expect.stringContaining("+++ fixture.txt"),
      firstChangedLine: expect.any(Number),
    });
    expect(piChatResultSchema.parse(JSON.parse(JSON.stringify({ messages }))).messages).toEqual(
      messages,
    );
    expect(messages.flatMap((message) => message.toolCalls ?? [])[0]?.input).toContain(
      "fixture.txt",
    );
    const id = runtime.id;
    await runtime.dispose();
    runtime = undefined;
    expect((await new FilePiChatStore(cwd).messages(id)).at(-1)?.text).toBe(reply);
    expect(
      (await new FilePiChatStore(cwd).messages(id)).find((message) => message.toolName === "edit"),
    ).toEqual(edit);
    runtime = await createPiChatRuntime(cwd, id, agentDir);
    expect(runtime.id).toBe(id);
    expect(runtime.messages().at(-1)?.text).toBe(reply);
    expect(calls).toBe(3);
  } finally {
    await runtime?.dispose();
    server.stop(true);
    if (previousOffline === undefined) delete Bun.env.PI_OFFLINE;
    else Bun.env.PI_OFFLINE = previousOffline;
    if (previousNoProxy === undefined) delete Bun.env.NO_PROXY;
    else Bun.env.NO_PROXY = previousNoProxy;
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

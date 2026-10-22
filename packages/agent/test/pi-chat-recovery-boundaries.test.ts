import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createPiChatRuntime } from "#src/pi-chat/runtime";
import { PiChatRecoveryUncertain } from "#src/pi-chat/checkpoint";

for (const state of [
  "accepted-before-prompt",
  "completed-with-failed-tool",
  "failed-tool",
  "missing-tool-result",
] as const) {
  test(`native recovery handles ${state} without repeating committed work`, async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "pi-chat-boundary-"));
    const previousOffline = Bun.env.PI_OFFLINE;
    const previousNoProxy = Bun.env.NO_PROXY;
    let runtime: Awaited<ReturnType<typeof createPiChatRuntime>> | undefined;
    let calls = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        calls++;
        return new Response(
          `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Recovered first input" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      Bun.env.PI_OFFLINE = "1";
      Bun.env.NO_PROXY = "*";
      const cwd = join(root, "workspace");
      const agent = join(root, "agent");
      await mkdir(cwd);
      await mkdir(agent);
      await Bun.write(
        join(agent, "auth.json"),
        JSON.stringify({ openai: { type: "api_key", key: "fixture-key" } }),
      );
      await Bun.write(
        join(agent, "models.json"),
        JSON.stringify({
          providers: {
            openai: {
              baseUrl: `${server.url}v1`,
              models: [{ id: "fixture", api: "openai-completions" }],
            },
          },
        }),
      );
      await Bun.write(
        join(agent, "settings.json"),
        JSON.stringify({
          defaultProvider: "openai",
          defaultModel: "fixture",
          retry: { enabled: false },
        }),
      );
      const manager = SessionManager.create(cwd, join(cwd, ".pi-sessions"));
      const assistant = {
        role: "assistant" as const,
        api: "openai-completions" as const,
        provider: "openai",
        model: "fixture",
        timestamp: Date.now(),
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      if (state !== "accepted-before-prompt")
        manager.appendMessage({
          role: "user",
          content: "Check the missing file",
          timestamp: Date.now(),
        });
      if (state !== "accepted-before-prompt")
        manager.appendMessage({
          ...assistant,
          stopReason: "toolUse",
          content: [
            { type: "toolCall", id: "read_file", name: "read", arguments: { path: "missing.txt" } },
          ],
        });
      if (state !== "missing-tool-result" && state !== "accepted-before-prompt")
        manager.appendMessage({
          role: "toolResult",
          toolCallId: "read_file",
          toolName: "read",
          isError: true,
          content: [{ type: "text", text: "File does not exist" }],
          timestamp: Date.now(),
        });
      if (state === "completed-with-failed-tool")
        manager.appendMessage({
          ...assistant,
          stopReason: "stop",
          content: [{ type: "text", text: "The requested file does not exist." }],
        });
      if (state === "accepted-before-prompt") {
        runtime = await createPiChatRuntime(cwd, undefined, agent);
        const id = runtime.id;
        await runtime.dispose();
        runtime = await createPiChatRuntime(cwd, id, agent);
      } else runtime = await createPiChatRuntime(cwd, manager.getSessionId(), agent);
      const checkpoint = {
        requestId: crypto.randomUUID(),
        message: "Check the missing file",
        messageCount: 0,
      };
      if (state === "completed-with-failed-tool" || state === "accepted-before-prompt")
        await runtime.resume(checkpoint);
      else await expect(runtime.resume(checkpoint)).rejects.toBeInstanceOf(PiChatRecoveryUncertain);
      expect(calls).toBe(state === "accepted-before-prompt" ? 1 : 0);
      expect(runtime.messages().filter((message) => message.role === "user")).toHaveLength(1);
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
}

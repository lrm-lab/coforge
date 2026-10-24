import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePiChatStore } from "#src/pi-chat/storage";
import type { PiChatCommand, PiChatResult } from "@lrm/coforge-sdk/internal/pi-chat";

function worker(root: string, agent: string, workspace: string, user: string) {
  const source = `import { runPiChatWorker } from ${JSON.stringify(join(import.meta.dir, "../src/pi-chat/worker.ts"))}; await runPiChatWorker(Bun.env.CHAT_ROOT, Bun.env.CHAT_WORKSPACE, Bun.env.CHAT_USER);`;
  const child = Bun.spawn([process.execPath, "-e", source], {
    env: {
      ...Bun.env,
      PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1",
      NO_PROXY: "*",
      CHAT_ROOT: root,
      CHAT_WORKSPACE: workspace,
      CHAT_USER: user,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const pending = new Map<
    string,
    { resolve(value: PiChatResult): void; reject(error: Error): void }
  >();
  const lifetimeTimer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  void child.exited.then(() => {
    clearTimeout(lifetimeTimer);
    for (const call of pending.values()) call.reject(new Error("fixture worker exited"));
    pending.clear();
  });
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const reply = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        const call = pending.get(reply.id);
        pending.delete(reply.id);
        if (reply.error) call?.reject(new Error(reply.error));
        else call?.resolve(reply.result);
      }
    }
  })();
  void reading.catch(() => {});
  return {
    child,
    request(command: PiChatCommand) {
      const id = crypto.randomUUID();
      return new Promise<PiChatResult>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, command })}\n`);
      });
    },
    async close() {
      child.kill("SIGKILL");
      await child.exited;
      await reading;
    },
  };
}

test("a real worker resumes after a crash without repeating a committed tool or a finished answer", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "pi-chat-restart-native-"));
  const agent = join(root, "agent");
  const workspace = crypto.randomUUID();
  const user = crypto.randomUUID();
  const sessionsRoot = join(root, "sessions");
  const cwd = join(sessionsRoot, workspace, user);
  const waiting = Promise.withResolvers<void>();
  let calls = 0;
  let recover = false;
  let current: ReturnType<typeof worker> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json();
      calls++;
      if (!recover && calls === 2) {
        waiting.resolve();
        return new Response(new ReadableStream(), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (recover) {
        const inputs = body.messages.filter(
          (message: { role: string; content: unknown }) =>
            message.role === "user" && JSON.stringify(message.content).includes("Append once"),
        );
        expect(inputs).toHaveLength(1);
        expect(body.messages.some((message: { role: string }) => message.role === "tool")).toBe(
          true,
        );
      }
      const delta = recover
        ? { role: "assistant", content: "Recovered successfully" }
        : {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "append_once",
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({ command: "printf 'once\\n' >> marker.txt" }),
                },
              },
            ],
          };
      return new Response(
        `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: recover ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
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
    current = worker(sessionsRoot, agent, workspace, user);
    const requestId = crypto.randomUUID();
    const started = await current.request({
      action: "start",
      requestId,
      message: "Append once to marker.txt, then report completion.",
    });
    const session = started.session!;
    await Promise.race([
      waiting.promise,
      current.child.exited.then(() => {
        throw new Error("worker exited before its tool finished");
      }),
    ]);
    expect(await Bun.file(join(cwd, "marker.txt")).text()).toBe("once\n");
    const store = await FilePiChatStore.open(cwd);
    const checkpoint = await store.checkpoint(session.id);
    expect(checkpoint?.requestId).toBe(requestId);
    await current.close();
    current = undefined;
    recover = true;
    current = worker(sessionsRoot, agent, workspace, user);
    let result = await current.request({ action: "list" });
    const deadline = Date.now() + 10_000;
    while (result.sessions?.[0]?.status === "running" && Date.now() < deadline) {
      await Bun.sleep(10);
      result = await current.request({ action: "list" });
    }
    expect(result.sessions?.[0]?.status).toBe("idle");
    expect(calls).toBe(3);
    expect(await Bun.file(join(cwd, "marker.txt")).text()).toBe("once\n");
    expect(
      (await current.request({ action: "read", sessionId: session.id })).messages?.at(-1)?.text,
    ).toBe("Recovered successfully");
    await current.request({
      action: "start",
      sessionId: session.id,
      requestId,
      message: "Append once to marker.txt, then report completion.",
    });
    expect(calls).toBe(3);
    await current.close();
    current = undefined;
    // Crash window: native final answer committed, metadata settlement not committed yet.
    await store.save({ ...result.sessions![0]!, status: "running" });
    await store.saveCheckpoint(session.id, checkpoint!);
    current = worker(sessionsRoot, agent, workspace, user);
    result = await current.request({ action: "list" });
    while (result.sessions?.[0]?.status === "running" && Date.now() < deadline) {
      await Bun.sleep(10);
      result = await current.request({ action: "list" });
    }
    expect(result.sessions?.[0]?.status).toBe("idle");
    expect(calls).toBe(3);
    expect(await store.checkpoint(session.id)).toBeUndefined();
  } finally {
    await current?.close();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

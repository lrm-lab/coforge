import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import {
  piChatResultSchema,
  type PiChatCommand,
  type PiChatResult,
} from "@lrm/coforge-sdk/internal/pi-chat";

test("Computer's standalone Pi worker serves isolated history, deduplicates sends and shuts down without a Daemon", async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), "pi-chat-worker-"));
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return new Response(
        `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "worker reply ".repeat(400) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const agent = join(home, "pi-config");
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
          models: [{ id: "custom", api: "openai-completions" }],
        },
      },
    }),
  );
  await Bun.write(
    join(agent, "settings.json"),
    JSON.stringify({
      defaultProvider: "openai",
      defaultModel: "custom",
      retry: { enabled: false },
    }),
  );
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "../src/main.ts"), "__pi-chat"],
    {
      env: {
        ...Bun.env,
        HOME: home,
        USERPROFILE: home,
        XDG_DATA_HOME: join(home, "data"),
        PI_CODING_AGENT_DIR: agent,
        PI_OFFLINE: "1",
        NO_PROXY: "*",
        COFORGE_PI_CHAT_WORKSPACE_ID: crypto.randomUUID(),
        COFORGE_PI_CHAT_USER_ID: crypto.randomUUID(),
        COFORGE_DAEMON_API_KEY: "must-not-reach-tools",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<PiChatResult>>>();
  const replySchema = z.object({
    id: z.string(),
    result: piChatResultSchema.optional(),
    error: z.string().optional(),
  });
  const errors = new Response(child.stderr).text();
  const reading = (async () => {
    let text = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      text += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = text.indexOf("\n")) >= 0) {
        const reply = replySchema.parse(JSON.parse(text.slice(0, newline)));
        text = text.slice(newline + 1);
        const call = pending.get(reply.id);
        if (reply.result) call?.resolve(reply.result);
        else call?.reject(new Error(reply.error));
        pending.delete(reply.id);
      }
    }
  })();
  const call = async (command: PiChatCommand) => {
    const id = crypto.randomUUID();
    const deferred = Promise.withResolvers<PiChatResult>();
    pending.set(id, deferred);
    child.stdin.write(`${JSON.stringify({ id, command })}\n`);
    await child.stdin.flush();
    return deferred.promise;
  };
  try {
    expect((await call({ action: "list" })).sessions).toEqual([]);
    const requestId = crypto.randomUUID();
    const started = await call({ action: "start", requestId, message: "hello" });
    const id = started.session!.id;
    expect((await call({ action: "start", requestId, message: "hello" })).session?.id).toBe(id);
    let snapshot: PiChatResult;
    const deadline = Date.now() + 15_000;
    do {
      snapshot = await call({ action: "read", sessionId: id });
      if (Date.now() > deadline) throw new Error("worker turn did not settle");
      if (snapshot.session?.status === "running") await Bun.sleep(20);
    } while (snapshot.session?.status === "running");
    expect(snapshot.session?.status).toBe("idle");
    expect(snapshot.messages?.at(-1)?.text).toBe("worker reply ".repeat(400));
    expect(requests).toBe(1);
    expect(
      (await call({ action: "rename", sessionId: id, title: "Saved conversation" })).session?.title,
    ).toBe("Saved conversation");
    expect((await call({ action: "delete", sessionId: id })).ok).toBe(true);
    expect((await call({ action: "list" })).sessions).toEqual([]);
    child.stdin.end();
    expect(await child.exited).toBe(0);
    await reading;
    expect(await errors).not.toContain("must-not-reach-tools");
  } finally {
    child.stdin.end();
    child.kill();
    await child.exited;
    await reading;
    server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);

/** Opt-in native Pi → Daemon WSS adapter → Web → private browser-channel contract.
 * Requires PI_CHAT_TEST_REDIS_URL pointing to an isolated local Redis.
 * Run through scripts/test/isolated-test-run.ts. Writes .amp/e2e/pi-chat-daemon.json.
 * The model and Centrifugo transport are local controlled fixtures; Pi/tools and Redis are real.
 */
import { expect, test } from "bun:test";
import { RedisClient } from "bun";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DaemonConnection } from "@lrm/coforge-daemon/src/connection/daemon-connection";
import type { CentrifugeWorkspaceClient } from "@lrm/coforge-daemon/src/connection/centrifuge-workspace-client";
import { PiChatRelay } from "@lrm/coforge-daemon/src/pi-chat/relay";
import {
  decodePiChatFrame,
  PI_CHAT_FRAME_METHOD,
  encodePiChatRequest,
  PiChatFrameAssembly,
} from "@lrm/coforge-sdk/internal/pi-chat-wire";
import { piChatEventSchema, type PiChatEvent } from "@lrm/coforge-sdk/internal/pi-chat";
import { PiChatGateway } from "#src/server/pi-chat/pi-chat-gateway.server";
import { RedisPiChatResults } from "#src/server/pi-chat/pi-chat-results.server";
import { createPiChatFrameMethod } from "#src/server/pi-chat/pi-chat-frame-receiver.server";

async function observedWithin(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Pi live feedback did not arrive within 10 seconds")),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("thinking, file tools and partial answers arrive before completion and history survives a worker restart", async () => {
  const redisUrl = Bun.env.PI_CHAT_TEST_REDIS_URL;
  if (!redisUrl || !/^redis:\/\/(127\.0\.0\.1|localhost):/.test(redisUrl))
    throw new Error("PI_CHAT_TEST_REDIS_URL must point to isolated local Redis");
  const directory = await mkdtemp(join(tmpdir(), "pi-chat-stream-e2e-"));
  const root = join(directory, "linked");
  await mkdir(join(directory, "physical"));
  await symlink(join(directory, "physical"), root, "dir");
  const scope = {
    workspaceId: crypto.randomUUID(),
    computerId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
  };
  const redis = new RedisClient(redisUrl);
  const results = new RedisPiChatResults(redis);
  const thinking = Promise.withResolvers<void>();
  const tool = Promise.withResolvers<void>();
  const partial = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  const releaseThinking = Promise.withResolvers<void>();
  const releaseAnswer = Promise.withResolvers<void>();
  const observed: PiChatEvent[] = [];
  const assemblies = new Map<string, PiChatFrameAssembly>();
  let calls = 0;
  const chunk = (delta: unknown, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({ id: "local-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      const turn = ++calls;
      return new Response(
        new ReadableStream({
          async start(controller) {
            const write = (text: string) => controller.enqueue(new TextEncoder().encode(text));
            if (turn === 1) {
              write(
                chunk({ role: "assistant", reasoning_content: "I will write and read the file." }),
              );
              await releaseThinking.promise;
              write(
                chunk(
                  {
                    tool_calls: [
                      {
                        index: 0,
                        id: "write-file",
                        type: "function",
                        function: {
                          name: "write",
                          arguments: JSON.stringify({
                            path: "stream-proof.txt",
                            content: "native file output",
                          }),
                        },
                      },
                    ],
                  },
                  "tool_calls",
                ),
              );
            } else if (turn === 2) {
              write(
                chunk(
                  {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "read-file",
                        type: "function",
                        function: {
                          name: "read",
                          arguments: JSON.stringify({ path: "stream-proof.txt" }),
                        },
                      },
                    ],
                  },
                  "tool_calls",
                ),
              );
            } else {
              write(chunk({ role: "assistant", content: "Partial answer" }));
              await releaseAnswer.promise;
              write(chunk({ content: " complete." }, "stop"));
            }
            write("data: [DONE]\n\n");
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const previous = {
    PI_CODING_AGENT_DIR: Bun.env.PI_CODING_AGENT_DIR,
    PI_OFFLINE: Bun.env.PI_OFFLINE,
    NO_PROXY: Bun.env.NO_PROXY,
  };
  const configDir = join(root, "config");
  await mkdir(configDir);
  await Bun.write(
    join(configDir, "auth.json"),
    JSON.stringify({ openai: { type: "api_key", key: "fixture" } }),
  );
  await Bun.write(
    join(configDir, "models.json"),
    JSON.stringify({
      providers: {
        openai: {
          baseUrl: `${model.url}v1`,
          models: [{ id: "local", api: "openai-completions", reasoning: true }],
        },
      },
    }),
  );
  await Bun.write(
    join(configDir, "settings.json"),
    JSON.stringify({ defaultProvider: "openai", defaultModel: "local", retry: { enabled: false } }),
  );
  Bun.env.PI_CODING_AGENT_DIR = configDir;
  Bun.env.PI_OFFLINE = "1";
  Bun.env.NO_PROXY = "*";
  let publish = (_bytes: Uint8Array) => {};
  let connected = () => {};
  const receiver = createPiChatFrameMethod({
    canUse: async () => true,
    results,
    publish: async (channel, bytes) => {
      expect(channel).toBe(`chat:user:${scope.userId}`);
      const frame = decodePiChatFrame(bytes);
      const assembly = assemblies.get(frame.frameId) ?? new PiChatFrameAssembly();
      assemblies.set(frame.frameId, assembly);
      const value = assembly.accept(frame);
      if (!value) return;
      assemblies.delete(frame.frameId);
      const event = piChatEventSchema.parse(value);
      observed.push(event);
      if (event.messages?.some((message) => message.thinking?.includes("write and read")))
        thinking.resolve();
      if (
        event.messages?.some(
          (message) => message.role === "tool" && message.text.includes("native file output"),
        )
      )
        tool.resolve();
      if (
        event.messages?.some(
          (message) => message.id === "streaming" && message.text === "Partial answer",
        )
      )
        partial.resolve();
      if (event.session?.status === "idle") settled.resolve();
    },
  });
  const client: CentrifugeWorkspaceClient = {
    on(event, callback) {
      if (event === "connected") connected = callback as () => void;
      if (event === "publication")
        publish = (data) =>
          callback({ channel: `daemon:${scope.workspaceId}:${scope.computerId}`, data } as never);
    },
    connect() {
      connected();
    },
    disconnect() {},
    async rpc(method, bytes) {
      return method === PI_CHAT_FRAME_METHOD
        ? receiver(bytes, { principal: scope })
        : new Uint8Array();
    },
  };
  const transport = new DaemonConnection("wss://fixture", () => client);
  let relay = new PiChatRelay(scope, (frame) => transport.sendPiChatFrame(frame), {
    command: [
      process.execPath,
      resolve("../../packages/agent/test/fixtures/pi-chat-stream-worker.ts"),
      join(root, "sessions"),
    ],
  });
  transport.onPiChatRequest((request) => relay.execute(request));
  await transport.start("fixture-key", scope);
  const gateway = new PiChatGateway({
    canUse: async () => true,
    online: async () => true,
    results,
    publish: async (request) => publish(encodePiChatRequest(request)),
  });
  const requestId = crypto.randomUUID();
  try {
    const start = await gateway.execute(scope, scope.computerId, {
      action: "start",
      requestId,
      message: "Write a file, read it and answer.",
    });
    const sessionId = start.session!.id;
    expect(start.session!.status).toBe("running");
    await observedWithin(thinking.promise);
    expect(observed.some((event) => event.session?.status === "idle")).toBe(false);
    releaseThinking.resolve();
    await observedWithin(tool.promise);
    await observedWithin(partial.promise);
    expect(
      (await gateway.execute(scope, scope.computerId, { action: "read", sessionId })).session!
        .status,
    ).toBe("running");
    expect(
      (
        await gateway.execute(scope, scope.computerId, {
          action: "start",
          requestId,
          message: "Write a file, read it and answer.",
        })
      ).session!.id,
    ).toBe(sessionId);
    expect(calls).toBe(3);
    releaseAnswer.resolve();
    await observedWithin(settled.promise);
    const final = await gateway.execute(scope, scope.computerId, { action: "read", sessionId });
    expect(final.messages!.at(-1)!.text).toBe("Partial answer complete.");
    await relay.close();
    relay = new PiChatRelay(scope, (frame) => transport.sendPiChatFrame(frame), {
      command: [
        process.execPath,
        resolve("../../packages/agent/test/fixtures/pi-chat-stream-worker.ts"),
        join(root, "sessions"),
      ],
    });
    expect(
      (await gateway.execute(scope, scope.computerId, { action: "read", sessionId })).messages,
    ).toEqual(final.messages);
    expect(calls).toBe(3);
    const file = join(root, "sessions", scope.workspaceId, scope.userId, "stream-proof.txt");
    expect(await Bun.file(file).text()).toBe("native file output");
    await Bun.write(
      resolve("../../.amp/e2e/pi-chat-daemon.json"),
      JSON.stringify(
        {
          passed: true,
          streamingBeforeCompletion: true,
          toolFeedback: true,
          nativeReload: true,
          deduplicated: true,
          modelRequests: calls,
          liveEvents: observed.length,
        },
        null,
        2,
      ),
    );
  } finally {
    releaseThinking.resolve();
    releaseAnswer.resolve();
    await relay.close();
    await transport.stop();
    redis.close();
    model.stop(true);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

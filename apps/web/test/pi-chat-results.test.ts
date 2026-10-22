import { expect, test } from "bun:test";
import { RedisPiChatResults } from "#src/server/pi-chat/pi-chat-results.server";
import { piChatFrames } from "@lrm/coforge-sdk/internal/pi-chat-wire";

test("chunked replies require a live pending scope, all parts, and are discarded after cancellation", async () => {
  const values = new Map<string, string>();
  const redis = {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string, ..._args: string[]) => {
      values.set(key, value);
      return "OK";
    },
    send: async (command: string, args: string[]) => {
      if (command === "MGET") return args.map((key) => values.get(key) ?? null);
      if (command === "DEL") {
        for (const key of args) values.delete(key);
        return 1;
      }
      const [, , pending, manifest, part, expected, parts, data] = args;
      if (
        values.get(pending!) !== expected ||
        (values.has(manifest!) && values.get(manifest!) !== parts)
      )
        return 0;
      values.set(manifest!, parts!);
      if (!values.has(part!)) values.set(part!, data!);
      return 1;
    },
  };
  const results = new RedisPiChatResults(redis);
  const request = {
    userId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    computerId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    command: { action: "list" as const },
  };
  const reply = {
    result: {
      messages: [{ id: "tool-1", role: "tool" as const, text: "完整工具输出".repeat(100_000) }],
    },
  };
  const frames = piChatFrames(request, request.requestId, "result", reply);
  await results.accept(frames[0]!);
  expect(values.size).toBe(0);
  await results.begin(request);
  await results.accept({ ...frames[0]!, userId: crypto.randomUUID() });
  expect(values.size).toBe(1);
  await results.accept(frames[0]!);
  expect(await results.read(request.requestId)).toBeUndefined();
  for (const frame of frames.slice(1)) await results.accept(frame);
  expect(await results.read(request.requestId)).toEqual(reply);
  await results.clear(request.requestId);
  expect(values.size).toBe(0);
  await results.accept(frames[0]!);
  expect(values.size).toBe(0);
});

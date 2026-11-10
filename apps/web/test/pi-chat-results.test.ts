import { expect, test } from "bun:test";
import {
  PI_CHAT_REPLY_TTL_SECONDS,
  RedisPiChatResults,
} from "#src/server/pi-chat/pi-chat-results.server";
import { piChatFrames } from "@lrm/coforge-sdk/internal/pi-chat-wire";

function fakeRedis() {
  const values = new Map<string, string>();
  const lifetimes: string[][] = [];
  const trips = { count: 0 };
  const redis = {
    get: async (key: string) => {
      trips.count++;
      return values.get(key) ?? null;
    },
    set: async (key: string, value: string, ...args: string[]) => {
      lifetimes.push(args);
      values.set(key, value);
      return "OK";
    },
    send: async (command: string, args: string[]) => {
      trips.count++;
      if (command === "MGET") return args.map((key) => values.get(key) ?? null);
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
  return { values, lifetimes, trips, redis };
}

const newRequest = () => ({
  userId: crypto.randomUUID(),
  workspaceId: crypto.randomUUID(),
  computerId: crypto.randomUUID(),
  requestId: crypto.randomUUID(),
  command: { action: "list" as const },
});

test("chunked replies need a live pending scope and all parts, and only their own scope reads them until they expire", async () => {
  const { values, lifetimes, trips, redis } = fakeRedis();
  const results = new RedisPiChatResults(redis);
  const request = newRequest();
  const scope = {
    userId: request.userId,
    workspaceId: request.workspaceId,
    computerId: request.computerId,
  };
  const reply = {
    result: {
      messages: [{ id: "tool-1", role: "tool" as const, text: "完整工具输出".repeat(100_000) }],
    },
  };
  const frames = piChatFrames(request, request.requestId, "result", reply);
  await results.accept(frames[0]!);
  expect(values.size).toBe(0);
  expect(await results.read(scope, request.requestId)).toEqual({ state: "gone" });
  await results.begin(request);
  expect(lifetimes).toEqual([["EX", String(PI_CHAT_REPLY_TTL_SECONDS)]]);
  await results.accept({ ...frames[0]!, userId: crypto.randomUUID() });
  expect(values.size).toBe(1);
  // A poll that finds no reply yet is one round trip, however many parts there will be.
  trips.count = 0;
  expect(await results.read(scope, request.requestId)).toEqual({ state: "pending" });
  expect(trips.count).toBe(1);
  await results.accept(frames[0]!);
  expect(await results.read(scope, request.requestId)).toEqual({ state: "pending" });
  for (const frame of frames.slice(1)) await results.accept(frame);
  expect(await results.read(scope, request.requestId)).toEqual({ state: "reply", reply });
  // Another user, Workspace or Computer finds nothing, and cannot tell it from an expired request.
  for (const other of ["userId", "workspaceId", "computerId"] as const)
    expect(
      await results.read({ ...scope, [other]: crypto.randomUUID() }, request.requestId),
    ).toEqual({ state: "gone" });
  // A read leaves the reply in place, so an answer lost on the way can be asked for again.
  expect(await results.read(scope, request.requestId)).toEqual({ state: "reply", reply });
  // Expiry takes the pending scope with it, and the reply is no longer served or accepted.
  for (const key of [...values.keys()].filter((key) => key.endsWith(":pending")))
    values.delete(key);
  expect(await results.read(scope, request.requestId)).toEqual({ state: "gone" });
  const stored = values.size;
  await results.accept(frames[0]!);
  expect(values.size).toBe(stored);
});

test("a reply that cannot be decoded reads as an error, not as a failure to ask again", async () => {
  const { values, redis } = fakeRedis();
  const request = newRequest();
  const prefix = `coforge:pi-chat:v1:${request.requestId}`;
  values.set(`${prefix}:pending`, JSON.stringify(request));
  values.set(`${prefix}:parts`, "1");
  values.set(`${prefix}:part:0`, Buffer.from('{"result":{"messages":7}}').toString("base64"));
  const read = await new RedisPiChatResults(redis).read(request, request.requestId);
  expect(read).toMatchObject({ state: "reply", reply: { error: expect.any(String) } });
});

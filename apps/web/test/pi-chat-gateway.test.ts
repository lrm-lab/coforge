import { expect, test } from "bun:test";
import { PiChatGateway, type PiChatResults } from "#src/server/pi-chat/pi-chat-gateway.server";
import type { PiChatRequest } from "@lrm/coforge-sdk/internal/pi-chat-wire";

type Read = PiChatResults["read"];
const identity = () => ({ workspaceId: crypto.randomUUID(), userId: crypto.randomUUID() });

function fixture(
  overrides: {
    canUse?: () => Promise<boolean>;
    online?: () => Promise<boolean>;
    publish?: (request: PiChatRequest) => Promise<void>;
    read?: Read;
  } = {},
) {
  const calls = { begun: [] as PiChatRequest[], published: [] as PiChatRequest[], reads: 0 };
  const gateway = new PiChatGateway({
    canUse: overrides.canUse ?? (async () => true),
    online: overrides.online ?? (async () => true),
    publish:
      overrides.publish ??
      (async (request) => {
        calls.published.push(request);
      }),
    results: {
      begin: async (request) => {
        calls.begun.push(request);
      },
      read: async (...args) => {
        calls.reads++;
        return overrides.read ? overrides.read(...args) : { state: "pending" };
      },
    },
  });
  return { gateway, calls };
}

test("start authorizes, publishes and answers at once with the request id, without waiting for the reply", async () => {
  const who = identity();
  const computerId = crypto.randomUUID();
  let authorized = false;
  const { gateway, calls } = fixture({
    canUse: async () => authorized,
    // A reply never arrives: a start that waited for it would hang here.
    read: () => new Promise(() => {}),
  });
  await expect(gateway.start(who, computerId, { action: "list" })).rejects.toThrow("ACCESS_DENIED");
  expect(calls.published).toEqual([]);
  authorized = true;
  const { requestId } = await gateway.start(who, computerId, { action: "list" });
  expect(calls.published).toEqual([{ ...who, computerId, requestId, command: { action: "list" } }]);
  expect(calls.begun).toEqual(calls.published);
  expect(calls.reads).toBe(0);
});

test("an offline computer or a failed publish refuses the start as unavailable", async () => {
  const who = identity();
  let online = false;
  let failPublish = false;
  const { gateway, calls } = fixture({
    online: async () => online,
    publish: async () => {
      if (failPublish) throw new Error("centrifugo down");
    },
  });
  const start = () => gateway.start(who, crypto.randomUUID(), { action: "list" });
  await expect(start()).rejects.toThrow("TEMPORARILY_UNAVAILABLE");
  expect(calls.begun).toEqual([]);
  online = true;
  failPublish = true;
  await expect(start()).rejects.toThrow("TEMPORARILY_UNAVAILABLE");
});

test("each start gets its own request id, whatever the command's own idempotency key", async () => {
  const who = identity();
  const computerId = crypto.randomUUID();
  const command = { action: "start" as const, requestId: crypto.randomUUID(), message: "run" };
  const { gateway, calls } = fixture();
  const first = await gateway.start(who, computerId, command);
  const second = await gateway.start(who, computerId, command);
  expect(first.requestId).not.toBe(second.requestId);
  expect(calls.published.map((request) => request.command)).toEqual([command, command]);
});

test("read answers pending until the daemon's reply is stored, then the parsed result", async () => {
  const who = identity();
  const computerId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  let reply: Awaited<ReturnType<Read>> = { state: "pending" };
  const asked: unknown[] = [];
  const { gateway } = fixture({
    read: async (scope, id) => {
      asked.push([scope, id]);
      return reply;
    },
  });
  expect(await gateway.read(who, computerId, requestId)).toEqual({ status: "pending" });
  reply = { state: "reply", reply: { result: { sessions: [] } } };
  expect(await gateway.read(who, computerId, requestId)).toEqual({
    status: "ready",
    result: { sessions: [] },
  });
  // The reply is looked up by the caller's own scope, so someone else's request id is no match.
  expect(asked[0]).toEqual([{ ...who, computerId }, requestId]);
});

test("read re-authorizes on every reply read: a lost membership or Computer refuses even a stored reply", async () => {
  let authorized = true;
  const { gateway } = fixture({
    canUse: async () => authorized,
    read: async () => ({ state: "reply", reply: { result: { sessions: [] } } }),
  });
  const read = () => gateway.read(identity(), crypto.randomUUID(), crypto.randomUUID());
  expect((await read()).status).toBe("ready");
  authorized = false;
  expect(await read()).toEqual({ status: "denied" });
});

test("read asks the store first and authorizes only a stored reply, so waiting costs no database work", async () => {
  let authorizations = 0;
  const states: Array<Awaited<ReturnType<Read>>> = [
    { state: "pending" },
    { state: "gone" },
    { state: "reply", reply: { error: "boom" } },
    { state: "reply", reply: { result: { sessions: [] } } },
  ];
  let next = 0;
  const { gateway } = fixture({
    canUse: async () => {
      authorizations++;
      return true;
    },
    read: async () => states[next++]!,
  });
  const read = () => gateway.read(identity(), crypto.randomUUID(), crypto.randomUUID());
  expect(await read()).toEqual({ status: "pending" });
  expect(await read()).toEqual({ status: "failed" });
  expect(authorizations).toBe(0);
  await read();
  await read();
  expect(authorizations).toBe(2);
});

test("read ends a failed command, an empty reply and an unknown or expired request as failed", async () => {
  const replies: Array<Awaited<ReturnType<Read>>> = [
    { state: "reply", reply: { error: "boom" } },
    { state: "reply", reply: {} },
    { state: "gone" },
  ];
  let next = 0;
  const { gateway } = fixture({ read: async () => replies[next++]! });
  for (let i = 0; i < replies.length; i++)
    expect(await gateway.read(identity(), crypto.randomUUID(), crypto.randomUUID())).toEqual({
      status: "failed",
    });
});

test("a store that cannot be reached is thrown, so the caller asks again", async () => {
  const { gateway } = fixture({
    read: async () => {
      throw new Error("redis down");
    },
  });
  await expect(gateway.read(identity(), crypto.randomUUID(), crypto.randomUUID())).rejects.toThrow(
    "redis down",
  );
});

import { expect, test } from "bun:test";
import { PiChatGateway } from "#src/server/pi-chat/pi-chat-gateway.server";
import type { PiChatRequest } from "@lrm/coforge-sdk/internal/pi-chat-wire";

test("authorizes every command and correlates its daemon reply without a host HTTP origin", async () => {
  const identity = { workspaceId: crypto.randomUUID(), userId: crypto.randomUUID() };
  const computerId = crypto.randomUUID();
  let authorized = false;
  let published: PiChatRequest | undefined;
  let cleared = "";
  const gateway = new PiChatGateway({
    canUse: async (scope) => {
      expect(scope).toEqual({ ...identity, computerId });
      return authorized;
    },
    online: async () => true,
    publish: async (request) => {
      published = request;
    },
    results: {
      begin: async () => {},
      read: async () => ({ result: { sessions: [] } }),
      clear: async (id) => {
        cleared = id;
      },
    },
  });
  await expect(gateway.execute(identity, computerId, { action: "list" })).rejects.toThrow(
    "ACCESS_DENIED",
  );
  expect(published).toBeUndefined();
  authorized = true;
  expect(await gateway.execute(identity, computerId, { action: "list" })).toEqual({ sessions: [] });
  expect(published).toMatchObject({ ...identity, computerId, command: { action: "list" } });
  expect(cleared).toBe(published!.requestId);
});

test("offline computers fail immediately; losing ownership while waiting refuses the result", async () => {
  let online = false;
  let authorized = true;
  let publications = 0;
  const gateway = new PiChatGateway({
    canUse: async () => authorized,
    online: async () => online,
    publish: async () => {
      publications++;
      authorized = false;
    },
    results: {
      begin: async () => {},
      read: async () => ({ result: { sessions: [] } }),
      clear: async () => {},
    },
  });
  const execute = () =>
    gateway.execute(
      { userId: crypto.randomUUID(), workspaceId: crypto.randomUUID() },
      crypto.randomUUID(),
      { action: "list" },
    );
  await expect(execute()).rejects.toThrow("TEMPORARILY_UNAVAILABLE");
  expect(publications).toBe(0);
  online = true;
  await expect(execute()).rejects.toThrow("ACCESS_DENIED");
});

test("a timed-out send keeps its original idempotency key for safe recovery", async () => {
  const requestId = crypto.randomUUID();
  const sent: PiChatRequest[] = [];
  let cleared = 0;
  let now = 0;
  const gateway = new PiChatGateway(
    {
      canUse: async () => true,
      online: async () => true,
      publish: async (request) => {
        sent.push(request);
      },
      results: {
        begin: async () => {},
        read: async () => undefined,
        clear: async () => {
          cleared++;
        },
      },
    },
    {
      now: () => now,
      wait: async () => {
        now += 30_000;
      },
      timeoutMs: 5,
    },
  );
  const identity = { userId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
  const computerId = crypto.randomUUID();
  for (let i = 0; i < 2; i++)
    await expect(
      gateway.execute(identity, computerId, { action: "start", requestId, message: "run once" }),
    ).rejects.toThrow("TEMPORARILY_UNAVAILABLE");
  expect(sent.map((request) => request.command)).toEqual(
    Array(2).fill({ action: "start", requestId, message: "run once" }),
  );
  expect(sent[0]!.requestId).not.toBe(sent[1]!.requestId);
  expect(cleared).toBe(2);
});

import { expect, test } from "bun:test";
import { createPiChatHandler, signPiChatRequest } from "#src/host/pi-chat-http";

test("only executes signed, fresh, scope-validated chat requests", async () => {
  const secret = "isolated-chat-test-secret";
  const now = 1_700_000_000_000;
  const scope = {
    computerId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
  };
  const body = JSON.stringify({ scope, command: { action: "list" } });
  let calls = 0;
  const handle = createPiChatHandler({
    secret,
    now: () => now,
    execute: async (received, command) => {
      expect(received).toEqual(scope);
      expect(command.action).toBe("list");
      calls++;
      return { sessions: [] };
    },
  });
  const request = (content: string, time: number, signature: string) =>
    new Request("http://localhost/pi-chat/v1", {
      method: "POST",
      body: content,
      headers: { "x-coforge-chat-time": String(time), "x-coforge-chat-signature": signature },
    });
  expect((await handle(request(body, now, "invalid")))?.status).toBe(401);
  expect(
    (await handle(request(body, now - 60_000, signPiChatRequest(secret, now - 60_000, body))))
      ?.status,
  ).toBe(401);
  const signed = signPiChatRequest(secret, now, body);
  expect((await handle(request(body.replace(scope.userId, "../other"), now, signed)))?.status).toBe(
    401,
  );
  const invalidBody = JSON.stringify({
    scope: { ...scope, userId: "../other" },
    command: { action: "list" },
  });
  expect(
    (await handle(request(invalidBody, now, signPiChatRequest(secret, now, invalidBody))))?.status,
  ).toBe(400);
  expect((await handle(request(body, now, signed)))?.status).toBe(200);
  expect(calls).toBe(1);
  expect(await handle(new Request("http://localhost/desktop/anything"))).toBeUndefined();
});

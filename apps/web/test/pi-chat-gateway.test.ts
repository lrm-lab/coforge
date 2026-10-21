import { expect, test } from "bun:test";
import { PiChatGateway } from "#src/server/pi-chat/pi-chat-gateway.server";
import { signPiChatRequest } from "@lrm/coforge-sdk/internal/pi-chat-auth";

test("authorizes every chat action before contacting the host, and signs only trusted identity", async () => {
  const identity = { workspaceId: crypto.randomUUID(), userId: crypto.randomUUID() };
  const computerId = crypto.randomUUID();
  const secret = "gateway-test-cluster-secret";
  let authorized = false;
  let calls = 0;
  const gateway = new PiChatGateway({
    origin: "http://host.internal:6090",
    secret,
    canUse: async (scope) => {
      expect(scope).toEqual({ ...identity, computerId });
      return authorized;
    },
    fetch: async (url, options) => {
      calls++;
      expect(String(url)).toBe("http://host.internal:6090/pi-chat/v1");
      const headers = new Headers(options?.headers);
      const body = String(options?.body);
      expect(headers.get("x-coforge-chat-signature")).toBe(
        signPiChatRequest(secret, Number(headers.get("x-coforge-chat-time")), body),
      );
      expect(JSON.parse(body).scope).toEqual({ ...identity, computerId });
      return Response.json({ sessions: [] });
    },
  });
  await expect(gateway.execute(identity, computerId, { action: "list" })).rejects.toThrow(
    "ACCESS_DENIED",
  );
  expect(calls).toBe(0);
  authorized = true;
  expect(await gateway.execute(identity, computerId, { action: "list" })).toEqual({ sessions: [] });
  expect(calls).toBe(1);
  authorized = false;
  await expect(
    gateway.execute(identity, computerId, { action: "delete", sessionId: crypto.randomUUID() }),
  ).rejects.toThrow("ACCESS_DENIED");
  expect(calls).toBe(1);
});

test("reports host failure without exposing host response bodies or secrets", async () => {
  const gateway = new PiChatGateway({
    origin: "http://host.internal",
    secret: "gateway-test-cluster-secret",
    canUse: async () => true,
    fetch: async () => new Response("secret credential contents", { status: 500 }),
  });
  await expect(
    gateway.execute(
      { userId: crypto.randomUUID(), workspaceId: crypto.randomUUID() },
      crypto.randomUUID(),
      { action: "list" },
    ),
  ).rejects.toThrow("TEMPORARILY_UNAVAILABLE");
});

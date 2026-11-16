import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { routeAgentEventsGet } from "#src/routes/api/agent/v1/events";

const db = {} as PrismaClient;

function route(principal: { workspaceId: string; agentId: string }) {
  const calls: string[] = [];
  const handlers = {
    inbox: async () => {
      calls.push("inbox");
      return new Response();
    },
    drain: async () => {
      calls.push("drain");
      return new Response();
    },
  };
  return {
    calls,
    run: () =>
      routeAgentEventsGet(
        new Request("https://example.test/api/agent/v1/events"),
        principal,
        db,
        handlers,
      ),
  };
}

test("an external Agent reads its inbox through the cursor-ack inbox, not the managed drain", async () => {
  const external = route({ workspaceId: "w", agentId: "a", external: true } as never);
  await external.run();
  expect(external.calls).toEqual(["inbox"]);
});

test("an app's bot keeps the inbox and a managed Agent keeps the drain", async () => {
  const bot = route({ workspaceId: "w", agentId: "a", appBot: true } as never);
  await bot.run();
  expect(bot.calls).toEqual(["inbox"]);
  const managed = route({ workspaceId: "w", agentId: "a" });
  await managed.run();
  expect(managed.calls).toEqual(["drain"]);
});

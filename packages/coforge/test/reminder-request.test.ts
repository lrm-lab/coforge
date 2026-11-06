import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { connectLocal } from "#src/local-client";

const proxyUrl = (route: { path: string } | string) =>
  `http://proxy.test${typeof route === "string" ? route : route.path}`;

afterEach(() => {
  mock.restore();
});

test("posts validated reminders to the derived endpoint with implicit bearer context", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      idempotencyKey: "request",
      workspaceId: "workspace",
      computerId: "computer",
      agentId: "agent",
      accepted: true,
      reminders: [],
      events: [],
    }),
  );
  await connectLocal("", `sfp_${"a".repeat(43)}`, proxyUrl(agentApiRoutes.local.messages)).reminder(
    {
      operation: "schedule",
      title: "Check release",
      target: "#general",
      messageId: "deadbeef",
      repeat: "daily@09:30",
      timezone: "Asia/Shanghai",
    },
  );
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toEqual(new URL(proxyUrl(agentApiRoutes.proxy.reminders.path)));
  expect(init?.headers).toEqual({
    authorization: `Bearer sfp_${"a".repeat(43)}`,
    "content-type": "application/json",
  });
  const body = JSON.parse(String(init?.body));
  expect(body).toMatchObject({
    operation: "schedule",
    title: "Check release",
    repeat: "daily@09:30",
    timezone: "Asia/Shanghai",
  });
  expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(body.context).toBeUndefined();
});

const reminderId = "123e4567-e89b-42d3-a456-426614174999";

test("a seal answer is the daemon's local shape, not the cloud operation response", async () => {
  const local = { accepted: true, reminderId, sealed: 2, owner: "@ada", until: "x" };
  spyOn(globalThis, "fetch").mockResolvedValue(Response.json(local));
  const result = await connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    proxyUrl(agentApiRoutes.local.messages),
  ).reminder({ operation: "seal", reminderId, owner: "@ada", until: "x" });
  expect(result).toEqual(local);
});

test("an unseal answer passes through the same way", async () => {
  const local = { accepted: true, reminderId, sealed: 1 };
  spyOn(globalThis, "fetch").mockResolvedValue(Response.json(local));
  const result = await connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    proxyUrl(agentApiRoutes.local.messages),
  ).reminder({ operation: "unseal", reminderId });
  expect(result).toEqual(local);
});

test("a sealed reminder's cancel refusal passes through as the local shape", async () => {
  const refusal = {
    accepted: false,
    reason: "sealed",
    owner: "@ada",
    until: "the deploy lands",
    reminderId,
  };
  spyOn(globalThis, "fetch").mockResolvedValue(Response.json(refusal));
  const result = await connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    proxyUrl(agentApiRoutes.local.messages),
  ).reminder({ operation: "cancel", reminderId });
  expect(result).toEqual(refusal);
});

test("a cloud-shaped reminder answer still goes through the operation codec", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      idempotencyKey: "request",
      workspaceId: "workspace",
      computerId: "computer",
      agentId: "agent",
      accepted: true,
      reminders: [],
      events: [],
    }),
  );
  const result = await connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    proxyUrl(agentApiRoutes.local.messages),
  ).reminder({ operation: "cancel", reminderId });
  expect(result).toMatchObject({ accepted: true, reminders: [], events: [] });
});

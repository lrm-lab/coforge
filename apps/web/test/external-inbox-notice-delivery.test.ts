import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { NOTICE_SCHEMA } from "#src/server/agents/external-inbox-notice-delivery.server";
import { NonPublicAddressError } from "#src/server/egress/outbound-egress.server";
import { NOW, SECRET, hint, setup } from "./helpers/notice-delivery-harness";

describe("a notice", () => {
  test("is a signed JSON body of hints only, with the delivery id header", async () => {
    const { sent, store, run } = await setup(() => ({ status: 204 }));
    await run("n1");
    expect(sent).toHaveLength(1);
    const { body, headers, url } = sent[0]!;
    expect(url).toBe("https://hooks.example/inbox");
    expect(headers["X-CoForge-Delivery-Id"]).toBe("n1");
    expect(headers["X-CoForge-Signature-256"]).toBe(
      `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
    );
    const parsed = JSON.parse(body);
    expect(parsed).toMatchObject({
      schema: NOTICE_SCHEMA,
      noticeId: "n1",
      recipientAgentId: "a1",
      occurredAt: NOW.toISOString(),
      targets: [hint],
    });
    expect(parsed.text).toBe("Inbox update: 3 unread in #general");
    expect(parsed.text).not.toContain("\n");
    expect(store.rows.get("a1")).toMatchObject({
      lastDeliveryAt: NOW,
      consecutiveFailures: 0,
      retryAt: null,
    });
  });

  test("is not sent when nothing is unread any more", async () => {
    const { sent, run } = await setup(() => ({ status: 204 }), { hints: [] });
    await run();
    expect(sent).toHaveLength(0);
  });

  test("is not sent for a disabled registration", async () => {
    const { sent, store, run } = await setup(() => ({ status: 204 }));
    store.rows.set("a1", { ...store.rows.get("a1")!, enabled: false });
    await run();
    expect(sent).toHaveLength(0);
  });
});

describe("a failed attempt is retried with the same notice id", () => {
  test.each([
    ["a 500", { status: 500 }, 5],
    ["a 503 with Retry-After 30", { status: 503, retryAfter: "30" }, 30],
    ["a 503 with Retry-After past the cap", { status: 503, retryAfter: "99999" }, 300],
    ["a 429 with Retry-After 600", { status: 429, retryAfter: "600" }, 600],
    ["a 429 with Retry-After past 60 minutes", { status: 429, retryAfter: "999999" }, 3600],
    ["a 400", { status: 400 }, 600],
    ["a timeout", Object.assign(new Error("t"), { name: "TimeoutError" }), 5],
    ["an unreachable host", new Error("refused"), 5],
  ])("%s", async (_name, outcome, delay) => {
    const { rescheduled, store, run } = await setup(() => outcome);
    await run("n7");
    expect(rescheduled).toEqual([{ agentId: "a1", noticeId: "n7", delaySeconds: delay }]);
    const row = store.rows.get("a1")!;
    expect(row).toMatchObject({ enabled: true, consecutiveFailures: 1, retryNoticeId: "n7" });
    expect(row.retryAt).toEqual(new Date(NOW.getTime() + delay * 1000));
    expect(row.lastError).not.toBeNull();
  });

  test("backoff doubles per failure and stops at five minutes", async () => {
    const { rescheduled, run } = await setup(() => ({ status: 500 }));
    for (let i = 0; i < 8; i++) await run("n1");
    expect(rescheduled.map((r) => r.delaySeconds)).toEqual([5, 10, 20, 40, 80, 160, 300, 300]);
  });

  test("the error recorded names the status, never anything the endpoint answered", async () => {
    const { store, run } = await setup(() => ({ status: 502 }));
    await run();
    expect(store.rows.get("a1")!.lastError).toBe("http_502");
  });

  test("a later success clears the failure state", async () => {
    let status = 500;
    const { store, run } = await setup(() => ({ status }));
    await run("n1");
    status = 204;
    await run("n1");
    expect(store.rows.get("a1")).toMatchObject({
      consecutiveFailures: 0,
      retryAt: null,
      retryNoticeId: null,
      lastError: null,
    });
  });
});

describe("an endpoint that rejects", () => {
  test.each([401, 404, 410])(
    "three consecutive %i answers turn the webhook off",
    async (status) => {
      const { store, rescheduled, run } = await setup(() => ({ status }));
      await run();
      await run();
      expect(store.rows.get("a1")).toMatchObject({ enabled: true, rejectionStreak: 2 });
      await run();
      expect(store.rows.get("a1")).toMatchObject({
        enabled: false,
        disabledReason: "endpoint_rejected",
      });
      expect(rescheduled).toHaveLength(2);
    },
  );

  test("an answer in between resets the streak", async () => {
    const answers = [401, 401, 500, 401, 401];
    const { store, run } = await setup(() => ({ status: answers.shift()! }));
    for (let i = 0; i < 5; i++) await run();
    expect(store.rows.get("a1")).toMatchObject({ enabled: true, rejectionStreak: 2 });
  });
});

describe("a recipient that is gone", () => {
  test.each([
    ["deleted", { deletedAt: NOW }],
    ["stopped", { stoppedAt: NOW }],
    ["no longer external", { hosting: "managed" }],
  ])("a %s Agent turns the webhook off without sending", async (_name, agent) => {
    const { store, sent, run } = await setup(() => ({ status: 204 }), { agent });
    await run();
    expect(sent).toHaveLength(0);
    expect(store.rows.get("a1")).toMatchObject({
      enabled: false,
      disabledReason: "agent_unavailable",
    });
  });

  test("an endpoint that no longer resolves publicly is retried, not trusted", async () => {
    const { run, rescheduled } = await setup(() => new NonPublicAddressError());
    await run();
    expect(rescheduled).toHaveLength(1);
  });
});

describe("a registration changed mid-attempt", () => {
  test("the stale attempt writes nothing", async () => {
    const { store, run } = await setup(() => {
      store.rows.set("a1", { ...store.rows.get("a1")!, revision: 2 });
      return { status: 500 };
    });
    await run();
    expect(store.rows.get("a1")!.consecutiveFailures).toBe(0);
  });
});

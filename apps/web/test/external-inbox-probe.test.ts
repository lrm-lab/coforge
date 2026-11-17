import { createHmac } from "node:crypto";
import { describe, expect, spyOn, test } from "bun:test";
import type { SendOptions } from "pg-boss";
import { NOTICE_SCHEMA } from "#src/server/agents/external-inbox-notice-delivery.server";
import {
  sendExternalInboxNotice,
  sendExternalInboxProbe,
  sendExternalInboxRetry,
  type NoticeBoss,
} from "#src/server/agents/external-inbox-notice-queue.server";
import { PROBE_WINDOW_SECONDS } from "#src/server/agents/external-push-recovery.server";
import { NOW, SECRET, setup } from "./helpers/notice-delivery-harness";

const HOUR = 3600 * 1000;

async function disabled(respond: () => { status: number } | Error) {
  const world = await setup(respond);
  const row = world.store.rows.get("a1")!;
  world.store.rows.set("a1", {
    ...row,
    disabledReason: "endpoint_rejected",
    lastError: "http_404",
    rejectionStreak: 3,
    disabledAt: NOW,
    nextProbeAt: new Date(NOW.getTime() + HOUR),
    probeAttempts: 0,
  });
  world.clock.at = new Date(NOW.getTime() + HOUR);
  return world;
}

describe("a recovery probe", () => {
  test("is a signed notice with no targets and the delivery id header", async () => {
    const { sent, probe } = await disabled(() => ({ status: 500 }));
    await probe();
    const { body, headers } = sent[0]!;
    expect(JSON.parse(body)).toMatchObject({
      schema: NOTICE_SCHEMA,
      recipientAgentId: "a1",
      text: "Inbox update: no pending targets",
      targets: [],
    });
    expect(headers["X-CoForge-Delivery-Id"]).toBe(JSON.parse(body).noticeId);
    expect(headers["X-CoForge-Signature-256"]).toBe(
      `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
    );
  });

  test("a 2xx answer turns push back on and announces what arrived meanwhile", async () => {
    const { store, announced, probes, probe, clock } = await disabled(() => ({ status: 204 }));
    await probe();
    expect(store.rows.get("a1")).toMatchObject({
      disabledReason: null,
      lastError: null,
      rejectionStreak: 0,
      consecutiveFailures: 0,
      nextProbeAt: null,
      disabledAt: null,
      probeAttempts: null,
      probeStoppedAt: null,
      lastDeliveryAt: clock.at,
    });
    expect(announced).toEqual(["a1"]);
    expect(probes).toEqual([]);
  });

  test("a failing answer schedules the next probe at double the gap, capped at a day", async () => {
    const { store, probes, probe, clock } = await disabled(() => ({ status: 404 }));
    const gaps: number[] = [];
    for (let i = 0; i < 8; i++) {
      await probe();
      const next = store.rows.get("a1")!.nextProbeAt!;
      gaps.push((next.getTime() - clock.at.getTime()) / HOUR);
      clock.at = next;
    }
    expect(gaps).toEqual([2, 4, 8, 16, 24, 24, 24, 24]);
    expect(probes.map((p) => p.delaySeconds / 3600)).toEqual(gaps);
    expect(store.rows.get("a1")).toMatchObject({
      disabledReason: "endpoint_rejected",
      probeAttempts: 8,
    });
  });

  test("an unreachable endpoint is just a failed probe", async () => {
    const { store, probe } = await disabled(() => new Error("refused"));
    await probe();
    expect(store.rows.get("a1")).toMatchObject({
      disabledReason: "endpoint_rejected",
      probeAttempts: 1,
    });
  });

  test("stops after 30 days and records when", async () => {
    const { store, probes, probe, clock } = await disabled(() => ({ status: 404 }));
    const end = new Date(NOW.getTime() + PROBE_WINDOW_SECONDS * 1000);
    let guard = 0;
    while (store.rows.get("a1")!.nextProbeAt && guard++ < 100) {
      clock.at = store.rows.get("a1")!.nextProbeAt!;
      await probe();
    }
    const row = store.rows.get("a1")!;
    expect(row).toMatchObject({ disabledReason: "endpoint_rejected", nextProbeAt: null });
    expect(row.probeStoppedAt).toEqual(clock.at);
    expect(clock.at.getTime()).toBeLessThanOrEqual(end.getTime());
    expect(end.getTime() - clock.at.getTime()).toBeLessThan(24 * HOUR);
    const scheduled = probes.length;
    await probe();
    expect(probes).toHaveLength(scheduled);
  });

  test("is skipped before it is due, for an enabled webhook and for other reasons", async () => {
    const early = await disabled(() => ({ status: 204 }));
    early.clock.at = new Date(NOW.getTime() + HOUR / 2);
    await early.probe();
    expect(early.sent).toHaveLength(0);

    const enabled = await disabled(() => ({ status: 204 }));
    enabled.store.rows.set("a1", { ...enabled.store.rows.get("a1")!, disabledReason: null });
    await enabled.probe();
    expect(enabled.sent).toHaveLength(0);

    const invalid = await disabled(() => ({ status: 204 }));
    invalid.store.rows.set("a1", {
      ...invalid.store.rows.get("a1")!,
      disabledReason: "endpoint_invalid",
    });
    await invalid.probe();
    expect(invalid.sent).toHaveLength(0);
  });

  test("an Agent that is gone ends the chain as agent_unavailable", async () => {
    const { store, sent, probe } = await disabled(() => ({ status: 204 }));
    const world = store.agents.get("a1")!;
    store.agents.set("a1", { ...world, deletedAt: NOW });
    await probe();
    expect(sent).toHaveLength(0);
    expect(store.rows.get("a1")).toMatchObject({
      disabledReason: "agent_unavailable",
      nextProbeAt: null,
    });
  });

  test("a stale probe writes nothing after a new PUT", async () => {
    const { store, probe } = await disabled(() => {
      store.rows.set("a1", { ...store.rows.get("a1")!, revision: 2 });
      return { status: 204 };
    });
    await probe();
    expect(store.rows.get("a1")).toMatchObject({ disabledReason: "endpoint_rejected" });
  });
});

describe("the probe job", () => {
  test("is keyed apart from the notice job so neither replaces the other", async () => {
    const sent: { name: string; data: unknown; options: unknown }[] = [];
    const boss = {
      send: async (name: string, data: unknown, options: unknown) => {
        sent.push({ name, data, options });
        return null;
      },
    };
    await sendExternalInboxProbe(boss, "a1", 7200);
    await sendExternalInboxNotice(boss, "a1");
    expect(sent[0]).toMatchObject({
      data: { agentId: "a1", probe: true },
      options: { singletonKey: "a1:probe", startAfter: 7200 },
    });
    expect(sent[1]).toMatchObject({ options: { singletonKey: "a1" } });
  });
});

function shortPolicyBoss() {
  const queued = new Set<string>();
  const sent: { data: unknown; options: SendOptions }[] = [];
  const boss: NoticeBoss = {
    send: async (_name, data, options) => {
      const key = options.singletonKey ?? crypto.randomUUID();
      if (queued.has(key)) return null;
      queued.add(key);
      sent.push({ data, options });
      return key;
    },
  };
  return { boss, sent };
}

describe("the retry job", () => {
  test("is not swallowed by a fresh notice already queued for the Agent", async () => {
    const { boss, sent } = shortPolicyBoss();
    await sendExternalInboxNotice(boss, "a1");
    await sendExternalInboxRetry(boss, "a1", "n1", 5);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      data: { agentId: "a1", noticeId: "n1" },
      options: { singletonKey: "a1:retry", startAfter: 5 },
    });
  });

  test("a send that returns null is logged as a structured event", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const { boss } = shortPolicyBoss();
    await sendExternalInboxNotice(boss, "a1");
    await sendExternalInboxNotice(boss, "a1");
    await sendExternalInboxProbe(boss, "a1", 10);
    await sendExternalInboxProbe(boss, "a1", 10);
    await sendExternalInboxRetry(boss, "a1", "n1", 5);
    await sendExternalInboxRetry(boss, "a1", "n2", 5);
    const events = warn.mock.calls.map(([line]) => JSON.parse(String(line)));
    warn.mockRestore();
    expect(events).toEqual([
      { event: "external_agent.inbox_notice_send_dropped", kind: "notice", agentId: "a1" },
      { event: "external_agent.inbox_notice_send_dropped", kind: "probe", agentId: "a1" },
      { event: "external_agent.inbox_notice_send_dropped", kind: "retry", agentId: "a1" },
    ]);
  });
});

describe("a probe that fires before it is due", () => {
  test("schedules itself again for the remaining time", async () => {
    const early = await disabled(() => ({ status: 204 }));
    early.clock.at = new Date(NOW.getTime() + HOUR - 90_500);
    await early.probe();
    expect(early.sent).toHaveLength(0);
    expect(early.probes).toEqual([{ agentId: "a1", delaySeconds: 91 }]);
  });
});

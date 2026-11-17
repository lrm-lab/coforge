import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { NOTICE_SCHEMA } from "#src/server/agents/external-inbox-notice-delivery.server";
import {
  sendExternalInboxNotice,
  sendExternalInboxProbe,
} from "#src/server/agents/external-inbox-notice-queue.server";
import { PROBE_WINDOW_SECONDS } from "#src/server/agents/external-push-recovery.server";
import { NOW, SECRET, setup } from "./helpers/notice-delivery-harness";

const HOUR = 3600 * 1000;

async function disabled(respond: () => { status: number } | Error) {
  const world = await setup(respond);
  const row = world.store.rows.get("a1")!;
  world.store.rows.set("a1", {
    ...row,
    enabled: false,
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
      enabled: true,
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
    expect(store.rows.get("a1")).toMatchObject({ enabled: false, probeAttempts: 8 });
  });

  test("an unreachable endpoint is just a failed probe", async () => {
    const { store, probe } = await disabled(() => new Error("refused"));
    await probe();
    expect(store.rows.get("a1")).toMatchObject({ enabled: false, probeAttempts: 1 });
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
    expect(row).toMatchObject({ enabled: false, nextProbeAt: null });
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
    enabled.store.rows.set("a1", { ...enabled.store.rows.get("a1")!, enabled: true });
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
    expect(store.rows.get("a1")).toMatchObject({ enabled: false });
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

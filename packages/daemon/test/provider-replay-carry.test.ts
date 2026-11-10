import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { connection, harness } from "./fixtures/provider-replay-harness";

afterAll(() => rm(connection.workspaceRoot, { recursive: true, force: true }));

type Harness = Awaited<ReturnType<typeof harness>>;

/** The notices of one session that tell of unread messages, as a recovery does. */
const unreadNotices = (notices: readonly string[]) =>
  notices.filter((notice) => notice.includes("--unread"));

/** The inbox notices of one session that tell of a delivery, not the catch-up of a recovery. */
const inboxNotices = (notices: readonly string[]) =>
  notices.filter(
    (notice) => notice.includes("CoForge inbox notice") && !notice.includes("--unread"),
  );

/** The ACKs of a tracked mention, with the envelope each echoed. */
const mentionAcks = (h: Harness, deliveryId: string) =>
  h.acks.filter((ack) => ack.deliveryId === deliveryId && ack.mentionDelivery);

/** Message 1 is told. Message 2 is a tracked mention whose notice the session has not accepted
 * (it is held open), so the mention is still being told when the replay is rejected. */
async function mentionInFlight(h: Harness) {
  h.liveTurn(true);
  await h.deliver(1);
  const open = h.gateNotices();
  const telling = h.deliver(2, h.envelope(2, "stored-1")).catch(() => {});
  await h.until(() => h.sessions[0]!.notices.length === 2);
  return { open, telling };
}

/** The fresh session's turn ends, and the daemon settles what it told during it. */
async function endTurn(h: Harness, session: number, deliveryId: string) {
  h.sessions[session]!.emit({ type: "completed", status: "completed" });
  await h.until(() => mentionAcks(h, deliveryId).length > 0);
}

test("a mention being told when the replay is rejected is carried, told once and ACKed with its re-issued envelope", async () => {
  const h = await harness({ resume: "stored-1" });
  const { open, telling } = await mentionInFlight(h);
  try {
    h.failTurn(h.sessions[0]!);
    await h.until(() => h.sessions.length === 2 && h.sessions[1]!.notices.length > 0);
    open();
    await telling;
    await h.until(() => inboxNotices(h.sessions[1]!.notices).length > 0);

    // The recovery counts what the mention does not cover; the mention is told on its own, once.
    expect(h.terminalErrors).toEqual([]);
    const fresh = h.sessions[1]!.notices;
    expect(unreadNotices(fresh).join("\n")).toContain("#general 1 new message");
    expect(unreadNotices(fresh).join("\n")).not.toContain("2 new messages");
    expect(inboxNotices(fresh)).toHaveLength(1);

    // The server issues it again for the fresh session, under the same delivery id.
    await h.deliver(2, h.reissue(2));
    expect(inboxNotices(h.sessions[1]!.notices)).toHaveLength(1);
    expect(h.transitions).toContainEqual({
      deliveryId: "delivery-2",
      stage: "daemon_pending",
      outcome: "coalesced",
    });

    await endTurn(h, 1, "delivery-2");
    expect(mentionAcks(h, "delivery-2")).toEqual([
      { deliveryId: "delivery-2", mentionDelivery: h.reissue(2) },
    ]);
  } finally {
    open();
    await h.runtime.stop();
  }
});

test("a mention that was drained is acknowledged again when reissued, not told", async () => {
  const h = await harness({ resume: "stored-1" });
  try {
    // Told while the Agent was idle, so it was ACKed with the first launch's envelope.
    await h.deliver(1, h.envelope(1, "stored-1"));
    h.failTurn(h.sessions[0]!);
    await h.until(() => h.sessions.length === 2 && h.sessions[1]!.notices.length > 0);
    const told = h.sessions[1]!.notices.length;

    await h.deliver(1, h.reissue(1));

    await h.until(() => mentionAcks(h, "delivery-1").length === 2);
    expect(h.sessions[1]!.notices).toHaveLength(told);
    expect(mentionAcks(h, "delivery-1").at(-1)).toEqual({
      deliveryId: "delivery-1",
      mentionDelivery: h.reissue(1),
    });
  } finally {
    await h.runtime.stop();
  }
});

test("a turn that ends before the carried mention is told settles nothing", async () => {
  const h = await harness({ resume: "stored-1" });
  const { open, telling } = await mentionInFlight(h);
  try {
    h.failTurn(h.sessions[0]!);
    await h.until(() => h.sessions.length === 2 && h.sessions[1]!.notices.length > 0);
    await telling;

    // The turn of the recovery notice the session still holds ends first.
    h.sessions[1]!.emit({ type: "completed", status: "completed" });
    expect(mentionAcks(h, "delivery-2")).toEqual([]);
    expect(h.terminalErrors).toEqual([]);

    open();
    await h.until(() => inboxNotices(h.sessions[1]!.notices).length > 0);
    await endTurn(h, 1, "delivery-2");
    expect(mentionAcks(h, "delivery-2")).toHaveLength(1);
  } finally {
    open();
    await h.runtime.stop();
  }
});

test("a process that will not exit leaves its tracked mentions as they were", async () => {
  const h = await harness({ resume: "stored-1", disposeFailures: 1 });
  const { open, telling } = await mentionInFlight(h);
  try {
    const told = h.sessions[0]!.notices.length;
    h.failTurn(h.sessions[0]!);
    await h.until(() => h.activities.some((activity) => activity.level === "error"));
    open();
    await telling;

    // Still the same session: nothing was handed back, and nothing it holds was told a second time.
    expect(h.sessions).toHaveLength(1);
    expect(h.terminalErrors).toEqual([]);
    expect(h.sessions[0]!.notices).toHaveLength(told);
    await endTurn(h, 0, "delivery-2");
  } finally {
    open();
    await h.runtime.stop();
  }
});

test("a repeat of a mention while the runtime ends is coalesced and held once", async () => {
  const gate = Promise.withResolvers<void>();
  const h = await harness({ resume: "stored-1", disposeGate: gate.promise });
  try {
    await h.deliver(1);
    h.failTurn(h.sessions[0]!);
    await h.disposing;
    await h.deliver(2, h.envelope(2, "stored-1"));
    await h.deliver(2, h.envelope(2, "stored-1"));
    gate.resolve();
    await h.until(() => h.sessions.length === 2 && inboxNotices(h.sessions[1]!.notices).length > 0);

    expect(h.transitions.filter(({ outcome }) => outcome === "coalesced")).toHaveLength(1);
    expect(inboxNotices(h.sessions[1]!.notices)).toHaveLength(1);
    expect(h.terminalErrors).toEqual([]);
  } finally {
    gate.resolve();
    await h.runtime.stop();
  }
});

test("a repeat of a mention while the new launch is starting is coalesced, not refused or told twice", async () => {
  const gate = Promise.withResolvers<void>();
  const h = await harness({ resume: "stored-1", createGate: gate.promise });
  const { open, telling } = await mentionInFlight(h);
  try {
    h.failTurn(h.sessions[0]!);
    await h.creating;
    await telling;

    // The runtime has ended and its launch has not reported a session yet.
    await h.deliver(2, h.envelope(2, "stored-1"));
    expect(h.terminalErrors).toEqual([]);
    expect(h.transitions.filter(({ outcome }) => outcome === "coalesced")).toHaveLength(1);

    gate.resolve();
    open();
    await h.until(() => h.sessions.length === 2 && inboxNotices(h.sessions[1]!.notices).length > 0);
    expect(inboxNotices(h.sessions[1]!.notices)).toHaveLength(1);
  } finally {
    gate.resolve();
    open();
    await h.runtime.stop();
  }
});

test("an inbox purge of the mention's channel rejects a mention kept for the next launch", async () => {
  const gate = Promise.withResolvers<void>();
  const h = await harness({ resume: "stored-1", disposeGate: gate.promise });
  try {
    await h.deliver(1);
    h.failTurn(h.sessions[0]!);
    await h.disposing;
    await h.deliver(2, h.envelope(2, "stored-1"));

    h.runtime.handleAgentInboxPurge({
      protocolMajor: 1,
      requestId: "purge-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      conversationIds: ["conversation-a"],
      targets: ["#general"],
      reason: "member_removed",
    });

    await h.until(() => h.terminalErrors.length > 0);
    expect(h.terminalErrors).toEqual(["DELIVERY_REJECTED"]);
  } finally {
    gate.resolve();
    await h.runtime.stop();
  }
});

test("a notice that settles after the new launch is registered leaves its mention to that launch, told once", async () => {
  const late = Promise.withResolvers<void>();
  const h = await harness({ resume: "stored-1", lateFailure: late.promise });
  let open = () => {};
  try {
    h.liveTurn(true);
    await h.deliver(1);
    const telling = h.deliver(2, h.envelope(2, "stored-1")).catch(() => {});
    await h.until(() => h.sessions[0]!.notices.length === 2);
    open = h.gateNotices();
    h.failTurn(h.sessions[0]!);
    // The old session is gone and the new launch is up, still telling its first notice, when the
    // old notice fails.
    await h.until(() => h.sessions.length === 2 && h.sessions[1]!.notices.length > 0);

    late.resolve();
    await telling;
    expect(h.terminalErrors).toEqual([]);

    open();
    await h.until(() => inboxNotices(h.sessions[1]!.notices).length > 0);
    expect(h.terminalErrors).toEqual([]);
    expect(inboxNotices(h.sessions[1]!.notices)).toHaveLength(1);
    await endTurn(h, 1, "delivery-2");
  } finally {
    late.resolve();
    open();
    await h.runtime.stop();
  }
});

test("a cold start that fails leaves the mention pending, and the launch after its cooldown tells it once", async () => {
  const h = await harness({ resume: "stored-1", failSessions: [2] });
  const { open, telling } = await mentionInFlight(h);
  try {
    h.failTurn(h.sessions[0]!);
    open();
    await telling;
    await h.until(() => h.sessions.length === 2 && inboxNotices(h.sessions[1]!.notices).length > 0);

    // Nothing is refused: no delivery started that launch, so no delivery is the one to reject.
    expect(h.terminalErrors).toEqual([]);
    expect(inboxNotices(h.sessions[1]!.notices)).toHaveLength(1);
    await endTurn(h, 1, "delivery-2");
  } finally {
    open();
    await h.runtime.stop();
  }
});

test("a person's Stop forgets a mention kept while the runtime ends, without a report", async () => {
  const gate = Promise.withResolvers<void>();
  const h = await harness({ resume: "stored-1", disposeGate: gate.promise });
  try {
    await h.deliver(1);
    h.failTurn(h.sessions[0]!);
    await h.disposing;
    await h.deliver(2, h.envelope(2, "stored-1"));

    const stopping = h.stop();
    gate.resolve();
    await stopping;

    expect(h.terminalErrors).toEqual([]);
  } finally {
    gate.resolve();
    await h.runtime.stop();
  }
});

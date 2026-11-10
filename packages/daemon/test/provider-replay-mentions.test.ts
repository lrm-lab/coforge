import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { newlyParked } from "#src/daemon-runtime/provider-replay-recovery";
import { connection, harness } from "./fixtures/provider-replay-harness";

afterAll(() => rm(connection.workspaceRoot, { recursive: true, force: true }));

/** The notices of one session that tell of unread messages. */
const unreadNotices = (notices: readonly string[]) =>
  notices.filter((notice) => notice.includes("--unread"));

test("a tracked mention the Agent was told of and drained is still in the unread summary", async () => {
  const h = await harness({ resume: "stored-1" });
  try {
    // Told while the Agent was idle, so it was ACKed: the server will not issue it again.
    await h.deliver(1, h.envelope(1, "stored-1"));
    h.failTurn(h.sessions[0]!);
    await h.until(() => h.sessions.length === 2 && h.sessions[1]!.notices.length > 0);

    expect(unreadNotices(h.sessions[1]!.notices).join("\n")).toContain("#general 1 new message");
    expect(h.terminalErrors).toEqual([]);
  } finally {
    await h.runtime.stop();
  }
});

test("a tracked mention still unsettled is left out of the summary, because the server issues it again", async () => {
  const h = await harness({ resume: "stored-1" });
  try {
    // Told during a turn, mention 2 stays pending until that turn ends.
    h.liveTurn(true);
    await h.deliver(1);
    await h.deliver(2, h.envelope(2, "stored-1"));
    // The session reports that its notice never reached the model, so the turn's end does not
    // settle it.
    h.sessions[0]!.emit({
      type: "notice-undelivered",
      text: "mention 2",
      deliveryIds: ["delivery-2"],
    });
    h.liveTurn(false);
    h.failTurn(h.sessions[0]!);
    await h.until(() => h.sessions.length === 2 && h.sessions[1]!.notices.length > 0);

    const told = unreadNotices(h.sessions[1]!.notices).join("\n");
    // Handed back to the server, which keeps it pending and issues it for the fresh Session.
    expect(h.terminalErrors).toEqual(["IDENTITY_UNKNOWN"]);
    expect(told).toContain("#general 1 new message");
    expect(told).not.toContain("2 new messages");
  } finally {
    await h.runtime.stop();
  }
});

test("a tracked mention the tracker no longer knows is counted, never lost", async () => {
  const h = await harness({ resume: "stored-1" });
  try {
    // The session refuses the notice, so the tracker settles the mention as rejected and forgets
    // it: it cannot say whether the server issues it again.
    h.refuseNotices(true);
    await h.deliver(1, h.envelope(1, "stored-1")).catch(() => {});
    h.refuseNotices(false);
    h.failTurn(h.sessions[0]!);
    await h.until(() => h.sessions.length === 2 && h.sessions[1]!.notices.length > 0);

    expect(unreadNotices(h.sessions[1]!.notices).join("\n")).toContain("#general 1 new message");
  } finally {
    await h.runtime.stop();
  }
});

test("a mention whose hand-back report could not be sent is counted", async () => {
  const h = await harness({ resume: "stored-1" });
  try {
    h.liveTurn(true);
    await h.deliver(1);
    await h.deliver(2, h.envelope(2, "stored-1"));
    h.sessions[0]!.emit({
      type: "notice-undelivered",
      text: "mention 2",
      deliveryIds: ["delivery-2"],
    });
    // The server never learns the mention was handed back, so it will not issue it again.
    h.failTerminalErrors(true);
    h.liveTurn(false);
    h.failTurn(h.sessions[0]!);
    await h.until(() => h.sessions.length === 2 && h.sessions[1]!.notices.length > 0);

    expect(unreadNotices(h.sessions[1]!.notices).join("\n")).toContain("#general 2 new messages");
    expect(h.terminalErrors).toEqual([]);
  } finally {
    await h.runtime.stop();
  }
});

test("a delivery parked after the attention was read is counted unless it was held then or handed back", () => {
  const parked = [{ deliveryId: "held" }, { deliveryId: "back" }, { deliveryId: "new" }];

  expect(newlyParked(parked, new Set(["held"]), ["back"])).toEqual([{ deliveryId: "new" }]);
});

test("a tracked mention that arrives while the runtime is ending is the server's to issue again", async () => {
  const gate = Promise.withResolvers<void>();
  const h = await harness({ resume: "stored-1", disposeGate: gate.promise });
  try {
    await h.deliver(1);
    h.failTurn(h.sessions[0]!);
    await h.disposing;
    // The old process is going away: the tracker refuses the mention as unknown instead of telling it.
    await h.deliver(2, h.envelope(2, "stored-1"));
    gate.resolve();
    await h.until(() => h.sessions.length === 2 && h.sessions[1]!.notices.length > 0);

    const told = unreadNotices(h.sessions[1]!.notices).join("\n");
    expect(h.terminalErrors).toEqual(["IDENTITY_UNKNOWN"]);
    expect(told).toContain("#general 1 new message");
    expect(told).not.toContain("2 new messages");
  } finally {
    gate.resolve();
    await h.runtime.stop();
  }
});

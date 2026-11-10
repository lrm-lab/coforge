import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { connection, harness } from "./fixtures/provider-replay-harness";

afterAll(() => rm(connection.workspaceRoot, { recursive: true, force: true }));

/** The notices of one session that tell of unread messages, one per target. */
const unreadNotices = (notices: readonly string[]) =>
  notices.filter((notice) => notice.includes("--unread"));

type Harness = Awaited<ReturnType<typeof harness>>;

/** Waits until the daemon has reported a failed launch. */
const launchFailed = (h: Harness) =>
  h.until(() =>
    h.activities.some(
      (activity) => activity.level === "error" && activity.detail?.includes("could not be started"),
    ),
  );

/** Rejects the first session's replay; the provider then fails the cold start that follows. */
async function failColdStart(h: Harness) {
  h.failTurn(h.sessions[0]!);
  await launchFailed(h);
}

test("a cold start that fails leaves its summary owed to the next launch, which tells it once", async () => {
  const h = await harness({ resume: "stored-1", failSessions: [2] });
  try {
    await h.deliver(1);
    await h.deliver(2);
    await failColdStart(h);
    // Nothing started: the fresh Session was never created.
    expect(h.sessions).toHaveLength(1);
    expect(h.invalidates).toHaveLength(1);

    await h.start();
    expect(h.sessions).toHaveLength(2);
    const told = unreadNotices(h.sessions[1]!.notices);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("#general 2 new messages");

    // Delivered: a later launch of the same Agent owes nothing. This stop leaves a debt alone (only
    // a person's Stop intent drops it), so an empty summary here means the debt was paid.
    await h.runtime.stopAgent("agent-a");
    await h.start();
    expect(h.sessions).toHaveLength(3);
    expect(unreadNotices(h.sessions[2]!.notices)).toEqual([]);
  } finally {
    await h.runtime.stop();
  }
});

test("messages parked while the runtime was ending are still owed after the cold start fails", async () => {
  const gate = Promise.withResolvers<void>();
  const h = await harness({ resume: "stored-1", failSessions: [2], disposeGate: gate.promise });
  try {
    await h.deliver(1);
    h.failTurn(h.sessions[0]!);
    await h.disposing;
    await h.deliver(2);
    gate.resolve();
    await launchFailed(h);

    await h.start();
    expect(unreadNotices(h.sessions[1]!.notices).join("\n")).toContain("#general 2 new messages");
  } finally {
    gate.resolve();
    await h.runtime.stop();
  }
});

test("a launch that fails again keeps what is owed for the one after it", async () => {
  const h = await harness({ resume: "stored-1", failSessions: [2, 3] });
  try {
    await h.deliver(1);
    await failColdStart(h);

    await expect(h.start()).rejects.toThrow("did not complete");
    expect(h.sessions).toHaveLength(1);

    await h.start();
    expect(h.sessions).toHaveLength(2);
    expect(unreadNotices(h.sessions[1]!.notices).join("\n")).toContain("#general 1 new message");
  } finally {
    await h.runtime.stop();
  }
});

test("a launch whose recovery notice was refused after the model answered stands and leaves it owed", async () => {
  const h = await harness({ resume: "stored-1", failSessions: [2] });
  try {
    await h.deliver(1);
    await failColdStart(h);

    // The launch stands, but the Agent was never told: the notice was refused.
    h.refuseNotices(true, true);
    await h.start();
    expect(h.sessions).toHaveLength(2);
    h.refuseNotices(false);

    // A stop that does not drop the debt (only a person's Stop intent does), then the next launch.
    await h.runtime.stopAgent("agent-a");
    await h.start();

    expect(h.sessions).toHaveLength(3);
    expect(unreadNotices(h.sessions[2]!.notices)[0]).toContain("#general 1 new message");
  } finally {
    await h.runtime.stop();
  }
});

test("a launch that stands on a refused recovery notice still tells the deliveries held for it", async () => {
  const h = await harness({ resume: "stored-1" });
  // A real session is mid-turn once it accepts a notice, so a turn's end releases no holds.
  h.liveTurn(true);
  const open = h.gateNotices();
  try {
    const telling = h.deliver(1).catch(() => {});
    await h.until(() => h.sessions[0]!.notices.some((notice) => notice.includes("#general")));
    // Waits behind message 1 in the old session's queue; the cold start keeps it held.
    const waiting = h.deliver(2, undefined, "#ops").catch(() => {});
    h.refuseNotices(true, true, "--unread");
    h.failTurn(h.sessions[0]!);
    await h.until(() => h.sessions.length === 2);
    open();
    await Promise.all([telling, waiting]);
    const ops = () =>
      h.sessions[1]!.notices.filter(
        (notice) => notice.includes("#ops") && !notice.includes("--unread"),
      );
    await h.until(() => ops().length > 0);
    h.refuseNotices(false);

    // Presented as for a launch with no recovery, once; the refused summary stays owed.
    expect(ops()).toHaveLength(1);
    await h.runtime.stopAgent("agent-a");
    await h.start();
    expect(unreadNotices(h.sessions[2]!.notices)[0]).toContain("#general 1 new message");
  } finally {
    open();
    await h.runtime.stop();
  }
});

test("a Stop drops what a failed cold start owed", async () => {
  const h = await harness({ resume: "stored-1", failSessions: [2] });
  try {
    await h.deliver(1);
    await failColdStart(h);

    await h.stop();
    await h.start();

    expect(h.sessions).toHaveLength(2);
    expect(unreadNotices(h.sessions[1]!.notices)).toEqual([]);
  } finally {
    await h.runtime.stop();
  }
});

test("a stale Stop the control fence refuses leaves what is owed", async () => {
  const h = await harness({ resume: "stored-1", failSessions: [2] });
  try {
    await h.deliver(1);
    await failColdStart(h);

    // Older than the Start that launched the Agent (epoch 1): AgentControl refuses it.
    const stale = h.runtime.handleAgentStop({
      protocolMajor: 1,
      requestId: "stop-stale",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      provider: "pi",
      controlEpoch: 0,
    });
    await expect(stale).rejects.toThrow("stale_control_request");
    await h.start();

    expect(h.sessions).toHaveLength(2);
    expect(unreadNotices(h.sessions[1]!.notices)[0]).toContain("#general 1 new message");
  } finally {
    await h.runtime.stop();
  }
});

test("a Stop followed at once by a Start does not tell what was owed", async () => {
  const h = await harness({ resume: "stored-1", failSessions: [2] });
  try {
    await h.deliver(1);
    await failColdStart(h);

    // Queued behind the Stop on the Agent's control record, with no wait between them.
    const stopping = h.stop();
    const starting = h.start();
    await Promise.all([stopping, starting]);

    expect(h.sessions).toHaveLength(2);
    expect(unreadNotices(h.sessions[1]!.notices)).toEqual([]);
  } finally {
    await h.runtime.stop();
  }
});

test("owed resume messages survive a Start that carries resume messages of its own", async () => {
  const message = (target: string, sequence: number) => ({
    messageId: `message-${target}-${sequence}`,
    deliveryId: `delivery-${target}-${sequence}`,
    conversationId: `conversation-${target}`,
    sequence,
    target,
    latestSenderKind: "human",
    latestSenderHandle: "ada",
    latestSenderDescription: "Ada",
    body: `body-${target}`,
  });
  const h = await harness({
    resume: "stored-1",
    failSessions: [2],
    start: { resumeMessages: [message("#ops", 1)] },
  });
  try {
    await failColdStart(h);

    await h.start({ resumeMessages: [message("#general", 2)] });

    const context = h.runtime.issueAgentContext("agent-a");
    const snapshot = await h.runtime.inbox(context, {
      idempotencyKey: "check",
      context,
      operation: "check",
    });
    // Both messages are recovered as such, not only counted in the summary.
    const targets = snapshot.entries.flatMap((entry) =>
      entry.kind === "message_target" ? [entry.messageTarget.target] : [],
    );
    expect(targets.sort()).toEqual(["#general", "#ops"]);
  } finally {
    await h.runtime.stop();
  }
});

test("a whole-runtime stop drops what a failed cold start owed", async () => {
  const h = await harness({ resume: "stored-1", failSessions: [2] });
  try {
    await h.deliver(1);
    await failColdStart(h);

    // The same runtime object comes back up; the cloud's next Start is the source of what is unread.
    await h.runtime.stop();
    await h.runtime.start(connection);
    await h.start();

    expect(h.sessions).toHaveLength(2);
    expect(unreadNotices(h.sessions[1]!.notices)).toEqual([]);
  } finally {
    await h.runtime.stop();
  }
});

test("deleting the Agent drops what a failed cold start owed", async () => {
  const h = await harness({ resume: "stored-1", failSessions: [2] });
  try {
    await h.deliver(1);
    await failColdStart(h);

    await h.deleteAgent();
    await h.start();

    expect(h.sessions).toHaveLength(2);
    expect(unreadNotices(h.sessions[1]!.notices)).toEqual([]);
  } finally {
    await h.runtime.stop();
  }
});

test("a Start that carries a summary for the same target does not count it twice", async () => {
  const h = await harness({ resume: "stored-1", failSessions: [2] });
  try {
    await h.deliver(1);
    await h.deliver(2);
    await failColdStart(h);

    await h.start({ unreadSummary: { "#general": 5, "#ops": 1 } });

    const told = unreadNotices(h.sessions[1]!.notices).join("\n");
    expect(told).toContain("#general 5 new messages");
    expect(told).toContain("#ops 1 new message");
    expect(told).not.toContain("7 new messages");
  } finally {
    await h.runtime.stop();
  }
});

test("a smaller summary from the Start leaves the larger owed count", async () => {
  const h = await harness({ resume: "stored-1", failSessions: [2] });
  try {
    await h.deliver(1);
    await h.deliver(2);
    await h.deliver(3);
    await failColdStart(h);

    await h.start({ unreadSummary: { "#general": 1 } });

    expect(unreadNotices(h.sessions[1]!.notices).join("\n")).toContain("#general 3 new messages");
  } finally {
    await h.runtime.stop();
  }
});

test("a prompt the failed cold start carried is owed to the next launch too", async () => {
  const h = await harness({
    resume: "stored-1",
    failSessions: [2],
    start: { resumePrompt: "Pick the migration back up." },
  });
  try {
    await failColdStart(h);

    await h.start();

    expect(h.sessions[1]!.notices.join("\n")).toContain("Pick the migration back up.");
  } finally {
    await h.runtime.stop();
  }
});

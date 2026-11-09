import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { connection, FAILED_TURN, harness, REJECTED } from "./fixtures/provider-replay-harness";

afterAll(() => rm(connection.workspaceRoot, { recursive: true, force: true }));

test("a resumed session whose replay the provider rejects is invalidated and cold-started", async () => {
  const h = await harness({ resume: "stored-1" });
  try {
    expect(h.sessions[0]!.options.sessionId).toBe("stored-1");
    h.failTurn(h.sessions[0]!);
    await h.until(() => h.sessions.length === 2);

    expect(h.sessions[0]!.disposed).toBe(true);
    expect(h.sessions[1]!.options.sessionMode).toBe("create");
    expect(h.sessions[1]!.options.sessionId).toBeUndefined();
    expect(h.invalidates).toHaveLength(1);
    expect(h.invalidates[0]).toMatchObject({
      agentId: "agent-a",
      provider: "pi",
      sessionId: "stored-1",
      launchId: "launch-1",
      reason: "provider_replay_rejected",
    });
    // The failed turn keeps its own error Activity, and the cold start is narrated after it,
    // with no stopped or crashed frame between them.
    const kinds = h.activities.map((activity) => activity.detailKind);
    const failed = h.activities.findIndex((activity) => activity.level === "error");
    const narrated = h.activities.findIndex((activity) =>
      activity.detail?.includes("replay rejected"),
    );
    expect(failed).toBeGreaterThanOrEqual(0);
    expect(narrated).toBeGreaterThan(failed);
    expect(kinds).not.toContain("runtime_crashed");
    expect(kinds).not.toContain("stopped");
  } finally {
    await h.runtime.stop();
  }
});

test("the message the failed turn was handling reaches the fresh session", async () => {
  const h = await harness({ resume: "stored-1" });
  try {
    await h.deliver(1);
    await h.deliver(2);
    expect(h.sessions[0]!.notices.join("\n")).toContain("#general");
    h.failTurn(h.sessions[0]!);
    await h.until(() => h.sessions.length === 2 && h.sessions[1]!.notices.length > 0);

    // Unread canonical state: the new session is told which conversation has unread messages and
    // reads them itself, as after a server Start.
    const told = h.sessions[1]!.notices.join("\n");
    expect(told).toContain("#general 2 new messages");
    expect(told).toContain("--unread");
  } finally {
    await h.runtime.stop();
  }
});

test("the rejected turn's failure does not hold back what arrives for the fresh session", async () => {
  const h = await harness({ resume: "stored-1" });
  try {
    h.failTurn(h.sessions[0]!);
    await h.until(() => h.sessions.length === 2);
    await h.until(() => h.sessions[1]!.notices.length > 0);
    const before = h.sessions[1]!.notices.length;
    await h.deliver(3);

    expect(h.sessions[1]!.notices.length).toBeGreaterThan(before);
    expect(h.sessions[1]!.notices.at(-1)).toContain("#general");
  } finally {
    await h.runtime.stop();
  }
});

test("a message arriving while the runtime is ending reaches the fresh session", async () => {
  const gate = Promise.withResolvers<void>();
  const h = await harness({ resume: "stored-1", disposeGate: gate.promise });
  try {
    await h.deliver(1);
    h.failTurn(h.sessions[0]!);
    await h.disposing;
    // The old process is going away: this one waits for the relaunch, then is told with the rest.
    await h.deliver(2);
    expect(h.sessions[0]!.notices.join("\n")).not.toContain("body-2");
    gate.resolve();
    await h.until(() => h.sessions.length === 2 && h.sessions[1]!.notices.length > 0);

    expect(h.sessions[1]!.notices.join("\n")).toContain("#general 2 new messages");
    // A message after the relaunch is delivered on its own, not folded into that notice.
    const before = h.sessions[1]!.notices.length;
    await h.deliver(3);
    expect(h.sessions[1]!.notices).toHaveLength(before + 1);
    expect(h.sessions[1]!.notices.at(-1)).not.toContain("2 new messages");
  } finally {
    gate.resolve();
    await h.runtime.stop();
  }
});

test("a failure carrying an HTTP status leaves no backoff behind for the fresh session", async () => {
  const h = await harness({ resume: "stored-1" });
  try {
    // A status makes it a provider API failure, which the turn's end does not lift.
    h.failTurn(h.sessions[0]!, {
      ...REJECTED,
      message:
        "unexpected status 400 Bad Request: Encrypted content could not be decrypted or parsed.",
    });
    await h.until(() => h.sessions.length === 2 && h.sessions[1]!.notices.length > 0);
    const before = h.sessions[1]!.notices.length;
    await h.deliver(3);

    expect(h.sessions[1]!.notices.length).toBeGreaterThan(before);
    expect(h.sessions[1]!.notices.at(-1)).toContain("#general");
  } finally {
    await h.runtime.stop();
  }
});

test("a runtime that would not exit leaves the recovery armed for the next rejected turn", async () => {
  const h = await harness({ resume: "stored-1", disposeFailures: 1 });
  try {
    h.failTurn(h.sessions[0]!);
    await h.disposing;
    await h.until(() =>
      h.activities.some(
        (activity) =>
          activity.level === "error" && activity.detail?.includes("Replacing the rejected"),
      ),
    );
    // Nothing was replaced: no invalidate, the old session still serves.
    expect(h.invalidates).toHaveLength(0);
    expect(h.sessions).toHaveLength(1);

    h.failTurn(h.sessions[0]!);
    await h.until(() => h.sessions.length === 2);
    expect(h.invalidates).toHaveLength(1);
    expect(h.sessions[1]!.options.sessionMode).toBe("create");
  } finally {
    await h.runtime.stop();
  }
});

test("a message the Agent already read is not recovered", async () => {
  const h = await harness({ resume: "stored-1" });
  try {
    h.failTurn(h.sessions[0]!);
    await h.until(() => h.sessions.length === 2);
    await h.until(() => h.sessions[1]!.notices.length > 0);

    // Nothing was unread, so the fresh session gets the ordinary starter, not a catch-up.
    expect(h.sessions[1]!.notices.join("\n")).not.toContain("--unread");
  } finally {
    await h.runtime.stop();
  }
});

test("a launch that did not resume a stored session is left alone", async () => {
  const h = await harness();
  try {
    h.failTurn(h.sessions[0]!);
    // Still serving: the next delivery reaches the same session.
    await h.deliver(1);

    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]!.disposed).toBe(false);
    expect(h.sessions[0]!.notices.join("\n")).toContain("#general");
    expect(h.invalidates).toHaveLength(0);
  } finally {
    await h.runtime.stop();
  }
});

test("a create-mode launch that carries a session id resumed nothing", async () => {
  const h = await harness({ resume: "stored-1", sessionMode: "create" });
  try {
    h.failTurn(h.sessions[0]!);
    await h.deliver(1);

    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]!.notices.join("\n")).toContain("#general");
    expect(h.invalidates).toHaveLength(0);
  } finally {
    await h.runtime.stop();
  }
});

test("a rejected replay is recovered once per launch, and the fresh session never loops", async () => {
  const h = await harness({ resume: "stored-1" });
  try {
    h.sessions[0]!.emit(REJECTED);
    h.sessions[0]!.emit(FAILED_TURN);
    h.sessions[0]!.emit(REJECTED);
    h.sessions[0]!.emit(FAILED_TURN);
    await h.until(() => h.sessions.length === 2);
    // The fresh session resumed nothing, so the same failure there changes nothing.
    h.failTurn(h.sessions[1]!);
    await h.deliver(4);

    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[1]!.disposed).toBe(false);
    expect(h.sessions[1]!.notices.at(-1)).toContain("#general");
    expect(h.invalidates).toHaveLength(1);
  } finally {
    await h.runtime.stop();
  }
});

test("any other failure of a resumed session leaves it running", async () => {
  const h = await harness({ resume: "stored-1" });
  try {
    h.failTurn(h.sessions[0]!, {
      type: "error",
      message: "internal server failure",
      providerErrorClass: "CodexTurnError",
    });
    await h.deliver(1);

    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]!.disposed).toBe(false);
    expect(h.sessions[0]!.notices.join("\n")).toContain("#general");
    expect(h.invalidates).toHaveLength(0);
  } finally {
    await h.runtime.stop();
  }
});

test("an Agent that is being stopped is not cold-started", async () => {
  const gate = Promise.withResolvers<void>();
  const h = await harness({ resume: "stored-1", disposeGate: gate.promise });
  try {
    const stopping = h.runtime.stopAgent("agent-a");
    h.failTurn(h.sessions[0]!);
    gate.resolve();
    await stopping;

    // The guard answers before anything awaits, so the stop's end is the observable.
    expect(h.sessions).toHaveLength(1);
    expect(h.invalidates).toHaveLength(0);
  } finally {
    gate.resolve();
    await h.runtime.stop();
  }
});

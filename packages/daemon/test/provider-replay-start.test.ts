import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { RUNNER_HOLD_REASONS } from "@lrm/coforge-sdk/internal";
import { connection, harness } from "./fixtures/provider-replay-harness";

afterAll(() => rm(connection.workspaceRoot, { recursive: true, force: true }));

/** Lets every step the daemon takes without waiting on I/O run to its end. */
const drained = () => new Promise((resolve) => setImmediate(resolve));

test("a summary-only Start's targets and a delivery since reach the fresh session together", async () => {
  const h = await harness({ resume: "stored-1", start: { unreadSummary: { "#ops": 3 } } });
  try {
    await h.until(() => h.sessions[0]!.notices.some((notice) => notice.includes("#ops")));
    await h.deliver(1);
    h.failTurn(h.sessions[0]!);
    await h.until(() => h.sessions.length === 2 && h.sessions[1]!.notices.length > 0);

    const told = h.sessions[1]!.notices.join("\n");
    expect(told).toContain("#ops 3 new messages");
    expect(told).toContain("#general 1 new message");
  } finally {
    await h.runtime.stop();
  }
});

test("a resume prompt and an introduction the rejected launch opened with reach the fresh session", async () => {
  const h = await harness({
    resume: "stored-1",
    start: { resumePrompt: "Pick the migration back up.", introductionPrompt: "Say hello once." },
  });
  try {
    h.failTurn(h.sessions[0]!);
    await h.until(() => h.sessions.length === 2);
    await h.until(() => h.sessions[1]!.notices.join("\n").includes("Pick the migration back up."));

    expect(h.sessions[1]!.notices.join("\n")).toContain("Say hello once.");
  } finally {
    await h.runtime.stop();
  }
});

test("a runner hold leaves the Session alone and the recovery armed", async () => {
  const h = await harness({ resume: "stored-1" });
  try {
    h.runtime.holdRunners(RUNNER_HOLD_REASONS.WORKSPACE_RESTART);
    h.failTurn(h.sessions[0]!);
    await drained();
    expect(h.sessions[0]!.disposed).toBe(false);
    expect(h.invalidates).toHaveLength(0);

    h.runtime.releaseRunners();
    h.failTurn(h.sessions[0]!);
    await h.until(() => h.sessions.length === 2);
    expect(h.invalidates).toHaveLength(1);
  } finally {
    await h.runtime.stop();
  }
});

test("a running background task leaves the Session alone until it ends", async () => {
  const h = await harness({ resume: "stored-1" });
  try {
    h.sessions[0]!.emit({ type: "subagent-progress", phase: "started", taskId: "task-1" });
    h.failTurn(h.sessions[0]!);
    await drained();
    expect(h.sessions[0]!.disposed).toBe(false);
    expect(h.invalidates).toHaveLength(0);

    h.sessions[0]!.emit({
      type: "subagent-progress",
      phase: "notification",
      taskId: "task-1",
      taskStatus: "completed",
    });
    h.failTurn(h.sessions[0]!);
    await h.until(() => h.sessions.length === 2);
    expect(h.invalidates).toHaveLength(1);
  } finally {
    await h.runtime.stop();
  }
});

test("a session the launch already had replaced is not cold-started again", async () => {
  const h = await harness({ resume: "stored-1", reportAs: "other-1" });
  try {
    const before = h.invalidates.length;
    h.failTurn(h.sessions[0]!);
    await drained();

    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]!.disposed).toBe(false);
    expect(h.invalidates).toHaveLength(before);
    expect(h.invalidates.map((invalidate) => invalidate.reason)).not.toContain(
      "provider_replay_rejected",
    );
  } finally {
    await h.runtime.stop();
  }
});

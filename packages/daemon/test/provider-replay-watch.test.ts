import { expect, test } from "bun:test";
import { ProviderReplayWatch, carriedStart } from "#src/daemon-runtime/provider-replay-recovery";
import { FAILED_TURN, REJECTED } from "./fixtures/provider-replay-harness";
import { captureDaemonLogs } from "./log-capture";

const open = { memoryAgent: false, replacedSessionId: undefined, reportedSessionId: undefined };
const settled = () => new Promise((resolve) => setImmediate(resolve));

test("a rejected replay that could not be replaced is logged, and the next rejected turn tries again", async () => {
  const { result: attempts, records } = await captureDaemonLogs(async () => {
    const watch = new ProviderReplayWatch("stored-1", open);
    const attempts: string[] = [];
    const replace = (outcome: Promise<boolean>) => (stored: string) => {
      attempts.push(stored);
      return outcome;
    };
    for (const outcome of [Promise.reject(new Error("boom")), Promise.resolve(false)]) {
      watch.observe(REJECTED, "agent-a", replace(outcome));
      watch.observe(FAILED_TURN, "agent-a", replace(outcome));
      await settled();
    }
    watch.observe(REJECTED, "agent-a", replace(Promise.resolve(true)));
    watch.observe(FAILED_TURN, "agent-a", replace(Promise.resolve(true)));
    await settled();
    // Replaced once: spent.
    watch.observe(REJECTED, "agent-a", replace(Promise.resolve(true)));
    watch.observe(FAILED_TURN, "agent-a", replace(Promise.resolve(true)));
    await settled();
    return attempts;
  });

  expect(attempts).toEqual(["stored-1", "stored-1", "stored-1"]);
  const failure = records.find(
    (record) => record.properties.event === "agent.runtime.replay_rejected_recovery_failed",
  );
  expect(failure).toMatchObject({ level: "error", properties: { agent_id: "agent-a" } });
});

test("a turn that ended without a rejected replay, and one in flight, start nothing", async () => {
  const watch = new ProviderReplayWatch("stored-1", open);
  const gate = Promise.withResolvers<boolean>();
  let started = 0;
  const replace = () => {
    started += 1;
    return gate.promise;
  };
  watch.observe(FAILED_TURN, "agent-a", replace);
  expect(started).toBe(0);
  watch.observe(REJECTED, "agent-a", replace);
  watch.observe(FAILED_TURN, "agent-a", replace);
  watch.observe(REJECTED, "agent-a", replace);
  watch.observe(FAILED_TURN, "agent-a", replace);
  expect(started).toBe(1);
  gate.resolve(false);
});

test("a Start's own recovery, prompts and the unread counts fold into one carried start", () => {
  const carried = carriedStart(
    {
      recovery: { unreadSummary: { "#ops": 3 }, unreadConversationIds: { "#ops": "c1" } },
      resumePrompt: "Continue.",
    },
    [
      { target: "#ops", pendingCount: 1 },
      { target: "#general", pendingCount: 2 },
    ],
    [{ target: "#general" }],
  );
  expect(carried).toEqual({
    recovery: {
      unreadSummary: { "#ops": 4, "#general": 3 },
      unreadConversationIds: { "#ops": "c1" },
    },
    resumePrompt: "Continue.",
  });
  expect(carriedStart({}, [], [])).toEqual({});
});

import { expect, test } from "bun:test";
import { AgentContexts } from "#src/daemon-runtime/agent-contexts";
import { PhaseBookkeeping } from "#src/daemon-runtime/phase-bookkeeping";
import type { ActivityLaunch } from "#src/daemon-runtime/activity-launch";
import type { ActivityDraft } from "#src/daemon-runtime/agent-activity-publisher";
import { captureDaemonLogs } from "./log-capture";

const launch = { launchId: "launch-a", clientSeq: 0, stopping: false } as ActivityLaunch;

function subject() {
  const rebriefs: string[] = [];
  const contexts = new AgentContexts(() => {
    throw new Error("no ledger in this test");
  });
  const rebrief = contexts.newContext.bind(contexts);
  const bookkeeping = new PhaseBookkeeping({
    launchFor: () => launch,
    publish: () => {},
    activityDraft: () => ({}) as ActivityDraft,
    contexts: {
      newContext: (agentId, runtime) => {
        // A launch names its runtime; a compaction does not.
        if (runtime === undefined) rebriefs.push(agentId);
        rebrief(agentId, runtime);
      },
      compactionFailed: () => ({ consecutive: 1, terminal: false }),
      compactionSucceeded: () => {},
    },
  });
  return { bookkeeping, rebriefs };
}

test("a finished compaction starts a new context, a launch does not", () => {
  const { bookkeeping, rebriefs } = subject();
  bookkeeping.start("compaction", "agent-a", launch, undefined);
  bookkeeping.finish("compaction", "agent-a", launch, undefined);
  expect(rebriefs).toEqual(["agent-a"]);
});

test("a compaction whose finish is inferred starts a new context too", () => {
  const { bookkeeping, rebriefs } = subject();
  bookkeeping.start("compaction", "agent-a", launch, undefined);
  bookkeeping.inferCompactionFinished("agent-a", launch, undefined, {
    inferredFrom: "resumed output",
  });
  expect(rebriefs).toEqual(["agent-a"]);
});

test("a finished review is no context cut", () => {
  const { bookkeeping, rebriefs } = subject();
  bookkeeping.start("review", "agent-a", launch, undefined);
  bookkeeping.finish("review", "agent-a", launch, undefined);
  expect(rebriefs).toEqual([]);
});

test("the third error during a compaction reports a spent session, and kinds follow Raft", () => {
  const kinds: string[] = [];
  const published: { kind?: string }[] = [];
  let failures = 0;
  const bookkeeping = new PhaseBookkeeping({
    launchFor: () => launch,
    publish: (_agentId, _launch, draft) => published.push(draft as { kind?: string }),
    activityDraft: (_agentId, kind) => ({ kind }) as never,
    contexts: {
      newContext: () => {},
      compactionSucceeded: () => {},
      compactionFailed: (_agentId, kind = "compaction_failed") => {
        failures++;
        kinds.push(kind);
        return { consecutive: failures, terminal: failures >= 3 };
      },
    },
  });
  bookkeeping.start("compaction", "agent-a", launch, undefined);
  bookkeeping.compactionError("agent-a", launch, "compaction failed");
  bookkeeping.compactionError("agent-a", launch, "compaction failed again");
  bookkeeping.compactionError("agent-a", launch, "context length exceeded");
  expect(kinds).toEqual([
    "compaction_failed",
    "compaction_recovery_exhausted",
    "compaction_input_too_large",
  ]);
  expect(published.filter((draft) => draft.kind === "runtime_error")).toHaveLength(1);
});

test("a cancelled compaction is not a failure, however many times it happens", () => {
  const counted: string[] = [];
  const bookkeeping = new PhaseBookkeeping({
    launchFor: () => launch,
    publish: () => {},
    activityDraft: (_agentId, kind) => ({ kind }) as never,
    contexts: {
      newContext: () => {},
      compactionSucceeded: () => {},
      compactionFailed: () => {
        counted.push("counted");
        return { consecutive: 3, terminal: true };
      },
    },
  });
  for (let round = 0; round < 3; round++) {
    bookkeeping.start("compaction", "agent-a", launch, undefined);
    bookkeeping.interrupt("compaction", "agent-a", launch, undefined);
  }
  expect(counted).toEqual([]);
});

test("an error outside an open compaction is not counted as a compaction failure", () => {
  const counted: string[] = [];
  const bookkeeping = new PhaseBookkeeping({
    launchFor: () => launch,
    publish: () => {},
    activityDraft: (_agentId, kind) => ({ kind }) as never,
    contexts: {
      newContext: () => {},
      compactionSucceeded: () => {},
      compactionFailed: () => {
        counted.push("counted");
        return { consecutive: 1, terminal: false };
      },
    },
  });
  bookkeeping.compactionError("agent-a", launch, "unrelated launch failure");
  expect(counted).toEqual([]);
});

test("a finished compaction logs the token numbers it started and ended with", async () => {
  let usage = { usedTokens: 100, windowTokens: 200 };
  const bookkeeping = new PhaseBookkeeping({
    launchFor: () => launch,
    publish: () => {},
    activityDraft: (_agentId, kind) => ({ kind }) as never,
    contexts: {
      newContext: () => {},
      compactionSucceeded: () => {},
      compactionFailed: () => ({ consecutive: 1, terminal: false }),
    },
    contextUsage: () => usage,
  });
  const { records } = await captureDaemonLogs(async () => {
    bookkeeping.start("compaction", "agent-a", launch, undefined);
    usage = { usedTokens: 20, windowTokens: 200 };
    bookkeeping.finish("compaction", "agent-a", launch, undefined);
  });
  expect(
    records
      .filter(
        (record: { properties: Record<string, unknown> }) =>
          record.properties.event === "agent.runtime.compaction_tokens",
      )
      .map((record: { properties: Record<string, unknown> }) => record.properties),
  ).toEqual([
    expect.objectContaining({
      outcome: "finished",
      tokens_before: 100,
      tokens_after: 20,
      window_tokens: 200,
    }),
  ]);
});

test("a compaction's own numbers win over our context readings", async () => {
  // Pi reports them on its compaction result; our readings may be missing entirely, which is
  // what the dev.1 log showed — the line carried an outcome and nothing else.
  const bookkeeping = new PhaseBookkeeping({
    launchFor: () => launch,
    publish: () => {},
    activityDraft: (_agentId, kind) => ({ kind }) as never,
    contexts: {
      newContext: () => {},
      compactionSucceeded: () => {},
      compactionFailed: () => ({ consecutive: 1, terminal: false }),
    },
    contextUsage: () => undefined,
  });
  const { records } = await captureDaemonLogs(async () => {
    bookkeeping.start("compaction", "agent-a", launch, undefined);
    bookkeeping.finish("compaction", "agent-a", launch, undefined, {
      tokensBefore: 112_630,
      tokensAfter: 40_369,
      windowTokens: 200_000,
    });
  });
  expect(
    records
      .filter(
        (record: { properties: Record<string, unknown> }) =>
          record.properties.event === "agent.runtime.compaction_tokens",
      )
      .map((record: { properties: Record<string, unknown> }) => record.properties),
  ).toEqual([
    expect.objectContaining({
      outcome: "finished",
      tokens_before: 112_630,
      tokens_after: 40_369,
      window_tokens: 200_000,
    }),
  ]);
});

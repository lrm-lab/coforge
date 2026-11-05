import { expect, test } from "bun:test";
import { AgentContexts } from "#src/daemon-runtime/agent-contexts";
import { PhaseBookkeeping } from "#src/daemon-runtime/phase-bookkeeping";
import type { ActivityLaunch } from "#src/daemon-runtime/activity-launch";
import type { ActivityDraft } from "#src/daemon-runtime/agent-activity-publisher";

const launch = { launchId: "launch-a", clientSeq: 0, stopping: false } as ActivityLaunch;

function subject() {
  const rebriefs: string[] = [];
  const contexts = new AgentContexts(
    () => {
      throw new Error("no ledger in this test");
    },
    () =>
      ({
        connection: { workspaceRoot: "/nonexistent", workspaceId: "workspace-a" },
        inputDrain: { get: () => undefined },
        session: () => undefined,
      }) as never,
  );
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

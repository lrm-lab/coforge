import { expect, test } from "bun:test";
import { AgentActivityPublisher } from "#src/daemon-runtime/agent-activity-publisher";
import { idleActivityDraft, stoppedActivityDraft } from "#src/daemon-runtime/activity-draft";

type Launch = { launchId: string; clientSeq: number; stopping: boolean };

function publisher(launch: () => Launch | undefined) {
  const sent: { agentId: string; launchId: string; detailKind: string }[] = [];
  const value = new AgentActivityPublisher<Launch>({
    currentLaunch: launch,
    transport: {
      sendAgentActivity: (activity) =>
        sent.push({
          agentId: activity.agentId,
          launchId: activity.launchId,
          detailKind: activity.detailKind,
        }),
    },
    recordClientSeq: () => {},
    reconcileIdleTurn: () => false,
  });
  return { value, sent };
}

const WORKSPACE = "workspace-a";
const launchFor = (): Launch => ({ launchId: "launch-1", clientSeq: 0, stopping: false });

test("an Activity published before the runtime is ready goes out once it is", () => {
  const live = launchFor();
  const { value, sent } = publisher(() => live);
  value.publish("agent-a", live, idleActivityDraft(WORKSPACE, "agent-a"));
  expect(sent).toEqual([]);

  value.enable();
  expect(sent).toEqual([{ agentId: "agent-a", launchId: "launch-1", detailKind: "idle" }]);
});

test("only the newest frame per Agent is kept, not a history", () => {
  const live = launchFor();
  const { value, sent } = publisher(() => live);
  value.publish("agent-a", live, idleActivityDraft(WORKSPACE, "agent-a"));
  value.publish("agent-a", live, stoppedActivityDraft(WORKSPACE, "agent-a"));

  value.enable();
  expect(sent.map((entry) => entry.detailKind)).toEqual(["stopped"]);
});

test("a launch that changed while the runtime was starting is dropped", () => {
  let live = launchFor();
  const { value, sent } = publisher(() => live);
  value.publish("agent-a", live, idleActivityDraft(WORKSPACE, "agent-a"));
  // The turn ended and a new launch took over before ready: the queued frame describes it.
  live = { launchId: "launch-2", clientSeq: 0, stopping: false };

  value.enable();
  expect(sent).toEqual([]);
});

test("nothing queued survives a disable, and a new launch's frames are published live", () => {
  const live = launchFor();
  const { value, sent } = publisher(() => live);
  value.publish("agent-a", live, idleActivityDraft(WORKSPACE, "agent-a"));
  value.disable();
  value.enable();
  expect(sent).toEqual([]);

  value.publish("agent-a", live, idleActivityDraft(WORKSPACE, "agent-a"));
  expect(sent).toHaveLength(1);
});

import { expect, test } from "bun:test";
import type { AgentSession } from "@lrm/coforge-anvil";
import { AgentLaunchCoordinator } from "#src/daemon-runtime/agent-launch-coordinator";
import { showQuietTurn, type RuntimeTurnPorts } from "#src/daemon-runtime/runtime-turn-management";
import type { AgentTaskIdleNudgeResponse } from "@lrm/coforge-sdk/agent";
import { activityHarness } from "./fixtures/activity-runtime";

type Session = { hasLiveTurn: boolean; notify?: (text: string) => Promise<void> };

/** The coordinator's own collaborators, faked down to what the idle nudge reads. */
function coordinator(options: {
  idle?: boolean;
  answer?: AgentTaskIdleNudgeResponse | undefined;
  session?: Session;
}) {
  const asked: Array<Record<string, unknown>> = [];
  const delivered: string[] = [];
  const session =
    options.session ??
    ({
      hasLiveTurn: false,
      notify: async (text: string) => {
        delivered.push(text);
      },
    } as Session);
  const coordinator = new AgentLaunchCoordinator({
    agentApiKeys: new Map([["agent-a", "sk_agent_key"]]),
    transport: () => ({
      agentTaskIdleNudge: async (request: Record<string, unknown>) => {
        asked.push(request);
        return options.answer ?? { send: true, items: [], backlog: [], text: "idle reminder" };
      },
    }),
    agentProcessManager: { session: () => (options.idle === false ? undefined : session) },
    deliveryQueue: { hasQueued: () => false, shouldHold: () => false },
    currentActivityLaunches: new Map([["agent-a", { launchId: "launch-1" }]]),
  } as never);
  return { coordinator, asked, delivered };
}

test("an idle Agent's coordinator asks with the Agent key and writes the reminder", async () => {
  const { coordinator: runtime, asked, delivered } = coordinator({});
  runtime.idleNudge.maybeAsk("agent-a");
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(asked).toHaveLength(1);
  expect(delivered).toEqual(["idle reminder"]);
});

test("no session means no ask, and a busy turn means no ask", async () => {
  const gone = coordinator({ idle: false });
  gone.coordinator.idleNudge.maybeAsk("agent-a");
  const busy = coordinator({ session: { hasLiveTurn: true } });
  busy.coordinator.idleNudge.maybeAsk("agent-a");
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(gone.asked).toHaveLength(0);
  expect(busy.asked).toHaveLength(0);
});

test("a quiet turn asks the reminder only when nothing is still running", () => {
  const asked: string[] = [];
  const ports = (waiting: boolean) =>
    ({
      activityPublisher: { lastBusy: () => undefined, publish: () => {} },
      drafts: { quietTurn: () => ({}) },
      systemCleaner: { onAgentWorkingToIdle: () => {} },
      idleNudge: { maybeAsk: (agentId: string) => asked.push(agentId) },
    }) as unknown as RuntimeTurnPorts;
  const launch = (waiting: boolean) => ({
    launchId: "launch-1",
    clientSeq: 0,
    stopping: false,
    backgroundTasks: { quietDetail: () => (waiting ? "Waiting for 1 background task" : undefined) },
  });
  showQuietTurn(ports(false), "agent-a", launch(false) as never, () => {});
  expect(asked).toEqual(["agent-a"]);
  asked.length = 0;
  showQuietTurn(ports(true), "agent-a", launch(true) as never, () => {});
  expect(asked).toEqual([]);
});

test("DaemonRuntime asks after a completed turn and writes the idle reminder", async () => {
  const sent: string[] = [];
  const nudges: string[] = [];
  const harness = await activityHarness(
    {
      computerId: "computer-idle-nudge-e2e",
      workspaceId: "workspace-idle-nudge-e2e",
      workspaceRoot: `/tmp/coforge-idle-nudge-${crypto.randomUUID()}`,
    },
    undefined,
    {
      async agentTaskIdleNudge() {
        nudges.push("asked");
        return {
          send: true,
          items: [],
          backlog: [],
          text: "follow up after turn",
        } satisfies AgentTaskIdleNudgeResponse;
      },
    },
  );
  try {
    const session = harness.session as AgentSession & { hasLiveTurn: boolean };
    Object.defineProperty(session, "hasLiveTurn", { value: false, writable: true });
    session.sendMessage = async (text) => {
      session.hasLiveTurn = true;
      sent.push(text);
    };
    session.notify = async (text) => {
      session.hasLiveTurn = true;
      sent.push(text);
    };
    await session.sendMessage("run one turn");
    harness.emitEvent({ type: "text-delta", text: "turn output" });
    session.hasLiveTurn = false;
    harness.emitEvent({ type: "completed", status: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(nudges).toEqual(["asked"]);
    expect(sent).toEqual(["run one turn", "follow up after turn"]);
  } finally {
    await harness.runtime.stop();
  }
});

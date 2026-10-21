import { expect, test } from "bun:test";
import {
  decodeAgentStartIntent,
  decodeAgentStopIntent,
  decodeAgentWorkspaceResetRequest,
  type AgentStartIntent,
} from "@lrm/coforge-sdk/internal";
import {
  AgentControl,
  type AgentControlAgent,
  type AgentControlStore,
} from "#src/server/agents/agent-control.server";
import { AgentIntroduction } from "#src/server/agents/agent-introduction.server";
import {
  AgentSessions,
  type RuntimeSessionReference,
} from "#src/server/agents/agent-sessions.server";

/** Real control chains and session selection over an Agent that already greeted its creator. */
function fixture(alreadyGreeted = true) {
  let agent: AgentControlAgent = {
    id: "a",
    workspaceId: "w",
    computerId: "source",
    ownerId: "owner",
    visibility: "private",
    runtimeConfig: {
      runtime: "pi",
      provider: { kind: "default" },
      model: "",
      modelProvider: "",
      reasoning: "",
    },
    identity: { sessionId: "native-old", state: "resumable" },
    introductionDueAt: new Date(),
    ownerUsername: "ada",
    state: null,
  };
  let reference: RuntimeSessionReference | null = {
    provider: "pi",
    computerId: "source",
    startRequestId: "old-start",
    daemonInstanceId: "old-daemon",
    sessionId: "native-old",
    sessionMode: "resume",
    state: "resumable",
  };
  const starts: AgentStartIntent[] = [];
  const commands: string[] = [];
  const store: AgentControlStore = {
    memberRole: async () => "owner",
    get: async () => structuredClone(agent),
    replace: async (before, state, options) => {
      if (!Bun.deepEquals(before.state, agent.state)) return false;
      if (options?.clearSession) reference = null;
      agent = { ...agent, state, identity: options?.clearSession ? undefined : state.identity };
      return true;
    },
  };
  const sessions = new AgentSessions(
    {
      read: async () => ({
        workspaceId: agent.workspaceId,
        computerId: agent.computerId,
        provider: "pi",
        reference,
      }),
      replace: async (_id, previous, next) => {
        if (reference !== previous) return false;
        reference = next;
        return true;
      },
    },
    async () => "daemon",
    { resendForCurrentSession: async () => {} },
  );
  const introductions = new AgentIntroduction({
    hasAgentMessage: async () => alreadyGreeted,
    settle: async () => {
      agent.introductionDueAt = null;
    },
  });
  const control: AgentControl = new AgentControl(
    store,
    {
      publish: async (_channel, bytes) => {
        const phase = agent.state!.phase;
        commands.push(phase);
        if (phase === "starting") {
          const start = decodeAgentStartIntent(bytes);
          starts.push(start);
          await control.authorizeLaunch(start);
          await control.result(start, {
            ...start,
            epoch: start.controlEpoch!,
            launchId: start.launchId!,
            phase: "started",
            sequence: 3,
            identity: { sessionId: start.sessionId ?? "native-new", state: "resumable" },
          });
        } else if (phase === "stopping") {
          const stop = decodeAgentStopIntent(bytes);
          await control.result(stop, {
            ...stop,
            provider: "pi",
            epoch: stop.controlEpoch!,
            phase: "stopped",
            sequence: 1,
          });
        } else {
          expect(phase).toBe("clearing");
          const reset = decodeAgentWorkspaceResetRequest(bytes);
          await control.result(reset, { ...reset, phase: "workspace-reset", sequence: 2 });
        }
      },
    },
    { run: async (_id, work) => work() },
    { timeoutMs: 100, fallbackMs: 0 },
    sessions,
    undefined,
    undefined,
    undefined,
    introductions,
  );
  return {
    control,
    starts,
    commands,
    move: (retainsSession: boolean) => {
      agent.computerId = "target";
      if (!retainsSession) agent.identity = undefined;
    },
  };
}

test.each(["restart", "reset-session", "full-reset"] as const)(
  "%s chooses the appropriate session and does not repeat a landed greeting",
  async (action) => {
    const f = fixture();
    const result = await f.control.execute({
      userId: "owner",
      workspaceId: "w",
      agentId: "a",
      requestId: action,
      action,
      ...(action === "full-reset" ? { confirmed: true } : {}),
    });
    expect(result.phase).toBe("completed");
    expect(f.commands).toEqual(
      action === "full-reset" ? ["stopping", "clearing", "starting"] : ["stopping", "starting"],
    );
    expect(f.starts).toHaveLength(1);
    expect(f.starts[0]!.sessionMode).toBe(action === "restart" ? "resume" : "create");
    expect(f.starts[0]!.sessionId).toBe(action === "restart" ? "native-old" : undefined);
    expect(f.starts[0]!.introductionPrompt).toBeUndefined();
  },
);

test("Computer or Daemon ready recovery resumes the saved session without another greeting", async () => {
  const f = fixture();
  await f.control.recover(
    {
      protocolMajor: 1,
      requestId: "daemon-ready",
      workspaceId: "w",
      computerId: "source",
      agentId: "a",
      provider: "pi",
      model: "",
      reasoning: "",
    },
    "owner",
  );
  expect(f.starts).toHaveLength(1);
  expect(f.starts[0]).toMatchObject({ sessionMode: "resume", sessionId: "native-old" });
  expect(f.starts[0]!.introductionPrompt).toBeUndefined();
});

test.each([
  ["copied", true],
  ["unavailable", false],
] as const)(
  "migration with a %s session does not make the Agent new",
  async (_state, retainsSession) => {
    const f = fixture();
    f.move(retainsSession);
    await f.control.publishStart(
      {
        protocolMajor: 1,
        requestId: "migration-start",
        workspaceId: "w",
        computerId: "target",
        agentId: "a",
        provider: "pi",
        model: "",
        modelProvider: "",
        reasoning: "",
      },
      "owner",
    );
    expect(f.starts).toHaveLength(1);
    expect(f.starts[0]!.computerId).toBe("target");
    expect(f.starts[0]!.sessionMode).toBe(retainsSession ? "resume" : "create");
    expect(f.starts[0]!.sessionId).toBe(retainsSession ? "native-old" : undefined);
    expect(f.starts[0]!.introductionPrompt).toBeUndefined();
  },
);

test.each(["restart", "reset-session", "full-reset", "migration"] as const)(
  "%s preserves a first greeting that has not landed yet",
  async (action) => {
    const f = fixture(false);
    if (action === "migration") {
      f.move(false);
      await f.control.publishStart(
        {
          protocolMajor: 1,
          requestId: action,
          workspaceId: "w",
          computerId: "target",
          agentId: "a",
          provider: "pi",
          model: "",
          reasoning: "",
        },
        "owner",
      );
    } else {
      await f.control.execute({
        userId: "owner",
        workspaceId: "w",
        agentId: "a",
        requestId: action,
        action,
        ...(action === "full-reset" ? { confirmed: true } : {}),
      });
    }
    expect(f.starts).toHaveLength(1);
    expect(f.starts[0]!.introductionPrompt).toContain("coforge message send --target '@ada'");
  },
);

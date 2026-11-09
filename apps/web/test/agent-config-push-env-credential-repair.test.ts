import { describe, expect, test } from "bun:test";
import { type AgentConfigSync } from "@lrm/coforge-sdk/internal";
import { AgentEnvironment } from "#src/server/agents/agent-environment.server";
import { ControlFenceLostError } from "#src/server/agents/agent-config-plan.server";
import { WorkspaceAgentRecovery } from "#src/server/agents/agent-runtime-control.server";
import type { AgentRecord } from "#src/server/db/repositories/agent.repositories.server";
import { configApplyOf, running, type ConfigApplyOptions } from "./fixtures/config-push";

type PushOptions = ConfigApplyOptions & { stopped?: boolean };

function pushOf(agent: AgentRecord, options: PushOptions = {}) {
  const events: string[] = [];
  const { apply, intents } = configApplyOf(() => agent, {
    ...options,
    onPublish: () => events.push("push"),
  });
  return { apply, events, intents };
}

describe("AgentEnvironment.save with a Daemon that takes a config push", () => {
  const owner = { workspaceId: "workspace-1", userId: "user-1" };
  function setup(options: PushOptions = {}) {
    const agent = running(options.stopped ? { stoppedAt: new Date("2026-09-17T00:00:00Z") } : {});
    const push = pushOf(agent, options);
    const environment = new AgentEnvironment(
      {
        findOwnedAgent: async () => agent,
        updateRuntimeConfig: async (_id, config, fence) => {
          push.events.push(fence ? "write:fenced" : "write");
          if (options.fenceLost && fence) throw new ControlFenceLostError();
          agent.runtimeConfig = config;
          agent.runtimeConfigRevision = (agent.runtimeConfigRevision ?? 0) + 1;
          return { runtimeConfig: config, runtimeConfigRevision: agent.runtimeConfigRevision };
        },
      },
      { getById: async () => agent },
      {
        stop: async () => void push.events.push("stop"),
        start: async (intent) => void push.events.push(`start:${intent.agentConfigRevision}`),
      },
      { run: async (_id, callback) => callback() },
      new Uint8Array(32).fill(7),
      push.apply,
    );
    return { environment, agent, ...push };
  }

  test("a running Agent is told the new environment's revision and never stopped", async () => {
    const f = setup();

    expect(await f.environment.save(owner, "agent-1", { TOKEN: "secret" })).toEqual({
      restart: "when-idle",
    });

    expect(f.events).toEqual(["write:fenced", "push"]);
    expect(f.agent.runtimeConfigRevision).toBe(1);
    expect(f.intents[0]).toMatchObject({ agentId: "agent-1", revision: 1 });
    expect(JSON.stringify(f.intents)).not.toContain("secret");
  });

  test("a stopped Agent never publishes", async () => {
    const f = setup({ stopped: true });
    expect(await f.environment.save(owner, "agent-1", { TOKEN: "secret" })).toEqual({
      restart: "deferred",
    });
    expect(f.events).toEqual(["write"]);
  });

  test("a failed publish leaves the environment saved and defers it", async () => {
    const f = setup({ publishFails: true });
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(await f.environment.save(owner, "agent-1", { TOKEN: "secret" })).toEqual({
        restart: "deferred",
      });
    } finally {
      console.warn = warn;
    }
    expect(f.agent.runtimeConfig!.environment).toBeDefined();
  });

  test.each([
    ["failed latest operation", { control: "failed" }],
    ["in-flight latest operation", { control: "starting" }],
    ["Workspace Memory Agent", { memoryAgent: true }],
  ] as const)("a %s stops, writes, then starts", async (_name, options) => {
    const f = setup(options);
    expect(await f.environment.save(owner, "agent-1", { TOKEN: "secret" })).toEqual({
      restart: "published",
    });
    expect(f.events).toEqual(["stop", "write", "start:1"]);
  });

  test("a control state that moved before the write falls back to stop, write, start", async () => {
    const f = setup({ fenceLost: true });
    expect(await f.environment.save(owner, "agent-1", { TOKEN: "secret" })).toEqual({
      restart: "published",
    });
    expect(f.events).toEqual(["write:fenced", "stop", "write", "start:1"]);
  });

  test("without the capability it still stops, writes, then starts with the revision", async () => {
    const f = setup({ supported: false });
    expect(await f.environment.save(owner, "agent-1", { TOKEN: "secret" })).toEqual({
      restart: "published",
    });
    expect(f.events).toEqual(["stop", "write", "start:1"]);
  });
});

describe("Daemon ready repair of a lost config push", () => {
  function recoveryOf(
    agents: AgentRecord[],
    options: { supported?: boolean; publishFails?: boolean } = {},
  ) {
    const intents: AgentConfigSync[] = [];
    let supportReads = 0;
    const push = {
      supports: async () => {
        supportReads += 1;
        return options.supported !== false;
      },
      publish: async (sync: AgentConfigSync) => {
        intents.push(sync);
        if (options.publishFails) throw new Error("centrifugo unavailable");
      },
    };
    const resent: string[] = [];
    const recovery = new WorkspaceAgentRecovery(
      {
        getById: async (id) => agents.find((agent) => agent.id === id),
        listOwnedInWorkspace: async () => [],
        listInWorkspace: async () => [],
        listForComputer: async () => agents,
        listDeletedForComputer: async () => [],
        create: async () => {
          throw new Error("not used");
        },
        update: async () => {
          throw new Error("not used");
        },
      },
      { readAgentRecoveryContext: async () => ({ resumeMessages: [], unreadSummary: {} }) },
      { publish: async () => {} },
      { run: async (_id, work) => work() },
      { resendPending: async ({ agentId }) => void resent.push(agentId) },
      undefined,
      undefined,
      undefined,
      push,
    );
    return { recovery, resent, intents, supportReads: () => supportReads };
  }

  test("publishes the current config of an Agent the Daemon reports running", async () => {
    const f = recoveryOf([running({ runtimeConfigRevision: 3 })]);

    await f.recovery.recoverWorkspace("workspace-1", "computer-1", ["agent-1"]);

    expect(f.intents).toMatchObject([{ agentId: "agent-1", model: "old", revision: 3 }]);
    expect(f.resent).toEqual(["agent-1"]);
  });

  test("publishes only to an Agent whose reported revision is behind the stored one", async () => {
    const agents = [
      running({ id: "agent-1", name: "current", runtimeConfigRevision: 3 }),
      running({ id: "agent-2", name: "ahead", runtimeConfigRevision: 3 }),
      running({ id: "agent-3", name: "behind", runtimeConfigRevision: 3 }),
      running({ id: "agent-4", name: "absent", runtimeConfigRevision: 3 }),
    ];
    const f = recoveryOf(agents);

    await f.recovery.recoverWorkspace(
      "workspace-1",
      "computer-1",
      agents.map((agent) => agent.id),
      [
        { agentId: "agent-1", revision: 3 },
        { agentId: "agent-2", revision: 4 },
        { agentId: "agent-3", revision: 2 },
      ],
    );

    expect(f.intents.map((sync) => sync.agentId).sort()).toEqual(["agent-3", "agent-4"]);
    expect(f.resent.sort()).toEqual(["agent-1", "agent-2", "agent-3", "agent-4"]);
  });

  test("reads whether the Daemon takes a push once per ready, not once per Agent", async () => {
    const second = running({ id: "agent-2", name: "second", runtimeConfigRevision: 5 });
    const f = recoveryOf([running({ runtimeConfigRevision: 3 }), second]);

    await f.recovery.recoverWorkspace("workspace-1", "computer-1", ["agent-1", "agent-2"]);

    expect(f.intents.map((sync) => sync.agentId).sort()).toEqual(["agent-1", "agent-2"]);
    expect(f.supportReads()).toBe(1);
  });

  test("publishes nothing for a stopped Agent, an unchanged one, or a Daemon without the capability", async () => {
    const stopped = recoveryOf([
      running({ runtimeConfigRevision: 3, stoppedAt: new Date("2026-09-17T00:00:00Z") }),
    ]);
    await stopped.recovery.recoverWorkspace("workspace-1", "computer-1", ["agent-1"]);
    const unchanged = recoveryOf([running()]);
    await unchanged.recovery.recoverWorkspace("workspace-1", "computer-1", ["agent-1"]);
    const unsupported = recoveryOf([running({ runtimeConfigRevision: 3 })], { supported: false });
    await unsupported.recovery.recoverWorkspace("workspace-1", "computer-1", ["agent-1"]);

    expect([...stopped.intents, ...unchanged.intents, ...unsupported.intents]).toEqual([]);
  });

  test("a failed repair stays with its Agent and does not fail the ready", async () => {
    const f = recoveryOf([running({ runtimeConfigRevision: 3 })], { publishFails: true });
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (line: string) => warnings.push(line);
    try {
      await f.recovery.recoverWorkspace("workspace-1", "computer-1", ["agent-1"]);
    } finally {
      console.warn = warn;
    }
    expect(JSON.parse(warnings[0]!)).toMatchObject({ event: "agent_recovery:agent_failed" });
  });
});

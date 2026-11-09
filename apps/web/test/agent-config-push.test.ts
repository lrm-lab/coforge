import { describe, expect, test } from "bun:test";
import {
  RUNTIME_PROVIDER,
  decodeAgentConfigSync,
  decodeAgentStartIntent,
} from "@lrm/coforge-sdk/internal";
import { AgentControlPublisher } from "#src/server/agents/agent-control-publisher.server";
import {
  createAgentConfigPush,
  publishAgentConfig,
} from "#src/server/agents/agent-config-apply.server";
import { agentStartIntent } from "#src/server/agents/manage-agents.server";
import { running } from "./fixtures/config-push";
import { fixture } from "./fixtures/manage-agents";

const principal = { userId: "user-1", workspaceId: "workspace-1", role: "admin" as const };
const edit = { agentId: "agent-1", description: "", provider: RUNTIME_PROVIDER.PI, model: "new" };

describe("ManageAgents.update with a Daemon that takes a config push", () => {
  test("a running Agent keeps its process: persist, publish the sync, never stop or start", async () => {
    const { agentManagement, records, controls, pushes } = fixture({ push: {} });
    records.push(running());

    const result = await agentManagement.update(principal, edit);

    expect(controls).toEqual(["persist", "push"]);
    expect(result.restart).toBe("when-idle");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({
      workspaceId: "workspace-1",
      computerId: "computer-1",
      agentId: "agent-1",
      provider: RUNTIME_PROVIDER.PI,
      model: "new",
      revision: 1,
    });
  });

  test("the write is a fenced push: the plan's fence reaches the repository", async () => {
    const { agentManagement, records, fences } = fixture({ push: {} });
    records.push(running());

    await agentManagement.update(principal, edit);

    expect(fences).toHaveLength(1);
  });

  test.each(["starting", "failed", "stopped", "stale", "none"] as const)(
    "a %s latest control operation does not prove it is running: stop, persist, start",
    async (control) => {
      const { agentManagement, records, controls, pushes, fences } = fixture({ push: { control } });
      records.push(running());

      const result = await agentManagement.update(principal, edit);

      expect(result.restart).toBe("published");
      expect(controls).toEqual(["stop", "persist", "start"]);
      expect(pushes).toEqual([]);
      expect(fences).toEqual([]);
    },
  );

  test("a provider change is never a push: stop, persist, start", async () => {
    const { agentManagement, records, controls, pushes, fences } = fixture({ push: {} });
    records.push(running());

    const result = await agentManagement.update(principal, {
      ...edit,
      provider: RUNTIME_PROVIDER.CODEX,
    });

    expect(result).not.toHaveProperty("newSession");
    expect(result.restart).toBe("published");
    expect(controls).toEqual(["stop", "persist", "start"]);
    expect(pushes).toEqual([]);
    expect(fences).toEqual([]);
  });

  test("a running Workspace Memory Agent is never pushed to: stop, persist, start", async () => {
    const { agentManagement, records, controls, pushes } = fixture({ push: { memoryAgent: true } });
    records.push(running());

    const result = await agentManagement.update(principal, edit);

    expect(result.restart).toBe("published");
    expect(controls).toEqual(["stop", "persist", "start"]);
    expect(pushes).toEqual([]);
  });

  test("a control state that moved before the write falls back to stop, persist, start", async () => {
    const { agentManagement, records, controls, pushes, fences } = fixture({
      push: { fenceLost: true },
    });
    records.push(running());

    const result = await agentManagement.update(principal, edit);

    expect(fences).toHaveLength(1);
    expect(result.restart).toBe("published");
    expect(controls).toEqual(["stop", "persist", "start"]);
    expect(pushes).toEqual([]);
    expect(records[0]!.runtimeConfig!.model).toBe("new");
  });

  test("a stopped Agent persists only and never publishes", async () => {
    const { agentManagement, records, controls, pushes } = fixture({ push: {} });
    records.push(running({ stoppedAt: new Date("2026-09-17T00:00:00Z") }));

    const result = await agentManagement.update(principal, edit);

    expect(result.restart).toBe("deferred");
    expect(controls).toEqual(["persist"]);
    expect(pushes).toEqual([]);
  });

  test("a failed publish leaves the config saved and defers it", async () => {
    const { agentManagement, records, controls } = fixture({ push: { publishFails: true } });
    records.push(running());
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (line: string) => warnings.push(line);
    try {
      const result = await agentManagement.update(principal, edit);

      expect(result.restart).toBe("deferred");
      expect(controls).toEqual(["persist", "push"]);
      expect(records[0]!.runtimeConfig!.model).toBe("new");
      expect(JSON.parse(warnings[0]!)).toMatchObject({
        event: "agent_config:push_failed",
        agent_id: "agent-1",
        config_revision: 1,
        error_type: expect.any(String),
      });
    } finally {
      console.warn = warn;
    }
  });

  test("a Daemon without the capability still stops, persists, then starts", async () => {
    const { agentManagement, records, controls, pushes } = fixture({ push: { supported: false } });
    records.push(running());

    const result = await agentManagement.update(principal, edit);

    expect(result.restart).toBe("published");
    expect(controls).toEqual(["stop", "persist", "start"]);
    expect(pushes).toEqual([]);
  });

  test("moving to another Computer still stops and starts", async () => {
    const { agentManagement, records, controls, pushes } = fixture({ push: {} });
    records.push(running({ computerId: undefined }));

    const result = await agentManagement.update(principal, { ...edit, computerId: "computer-2" });

    expect(result.restart).toBe("published");
    expect(controls).toEqual(["persist", "start"]);
    expect(pushes).toEqual([]);
  });

  test("a save that changes nothing the runtime reads publishes nothing", async () => {
    const { agentManagement, records, controls, pushes } = fixture({ push: {} });
    records.push(running());

    const result = await agentManagement.update(principal, {
      agentId: "agent-1",
      description: "new words",
      provider: RUNTIME_PROVIDER.PI,
      model: "old",
    });

    expect(result.restart).toBe("not-required");
    expect(controls).toEqual(["persist"]);
    expect(pushes).toEqual([]);
    expect(records[0]!.runtimeConfigRevision ?? 0).toBe(0);
  });

  test("each runtime save raises the revision by one, and a Start carries it", async () => {
    const { agentManagement, records, pushes } = fixture({ push: {} });
    records.push(running());

    await agentManagement.update(principal, edit);
    await agentManagement.update(principal, { ...edit, model: "newer" });

    expect(records[0]!.runtimeConfigRevision).toBe(2);
    expect(pushes.map((sync) => sync.revision)).toEqual([1, 2]);
    expect(agentStartIntent(records[0]!)).toMatchObject({ agentConfigRevision: 2 });
  });
});

describe("Start intents", () => {
  test("omit the config revision while it is 0 and carry it afterwards", () => {
    expect(agentStartIntent(running())).not.toHaveProperty("agentConfigRevision");
    expect(agentStartIntent(running({ runtimeConfigRevision: 0 }))).not.toHaveProperty(
      "agentConfigRevision",
    );
    expect(agentStartIntent(running({ runtimeConfigRevision: 3 }))).toMatchObject({
      agentConfigRevision: 3,
    });
  });
});

describe("the control publisher's Start", () => {
  test("carries the Agent's config revision once it has one", async () => {
    const sent: Uint8Array[] = [];
    const publisher = new AgentControlPublisher(
      {} as never,
      { publish: async (_channel, bytes) => void sent.push(bytes) },
      () => 0,
    );
    const agent = {
      id: "agent-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      ownerId: "user-1",
      visibility: "public",
      runtimeConfig: running().runtimeConfig!,
      state: null,
    };
    const state = {
      version: 1,
      protocolMajor: 1,
      requestId: "request-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      agentId: "agent-1",
      provider: RUNTIME_PROVIDER.PI,
      epoch: 1,
      action: "start",
      phase: "starting",
      configRevision: "hash",
      controlSequence: 0,
      sessionSequence: 0,
    } as const;

    await publisher.sendStart(agent, state, "launch-1", {});
    await publisher.sendStart({ ...agent, runtimeConfigRevision: 5 }, state, "launch-1", {});

    expect(decodeAgentStartIntent(sent[0]!).agentConfigRevision).toBeUndefined();
    expect(decodeAgentStartIntent(sent[1]!).agentConfigRevision).toBe(5);
  });
});

describe("createAgentConfigPush", () => {
  test("publishes the encoded sync on the Computer's control channel", async () => {
    const published: Array<{ channel: string; bytes: Uint8Array }> = [];
    const push = createAgentConfigPush({
      publish: async (channel, bytes) => void published.push({ channel, bytes }),
    });
    await publishAgentConfig(push, running({ runtimeConfigRevision: 2 }));

    expect(published).toHaveLength(1);
    expect(published[0]!.channel).toBe("daemon:workspace-1:computer-1");
    expect(decodeAgentConfigSync(published[0]!.bytes)).toMatchObject({
      agentId: "agent-1",
      provider: RUNTIME_PROVIDER.PI,
      model: "old",
      revision: 2,
    });
  });
});

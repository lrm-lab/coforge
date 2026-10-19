import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import { buildInitialMemoryMd } from "#src/agent-runtime/agent-memory-seed";
import type { AgentSession, AgentRuntimeConfig, AgentSessionOptions } from "@coforge/agent";
import type { CodeAgentProvider } from "#src/code-agent/contract";
import { AgentProcessCleanupError } from "#src/code-agent/contract";

function sessionSpy() {
  const exitListeners = new Set<() => void>();
  return {
    disposeCalls: 0,
    async sendMessage() {},
    subscribe() {
      return () => undefined;
    },
    async interrupt() {},
    onExit(listener: () => void) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    exit() {
      for (const listener of exitListeners) listener();
    },
    async dispose() {
      this.disposeCalls += 1;
      this.exit();
    },
  } satisfies AgentSession & { disposeCalls: number; exit(): void };
}

const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  reasoning: "balanced",
};
const testWorkspaceRoot = join(tmpdir(), `coforge-agent-manager-${crypto.randomUUID()}`);

afterAll(() => rm(testWorkspaceRoot, { recursive: true, force: true }));

describe("AgentProcessManager", () => {
  test("successful start owns its server launch identity through release and clears it on stop", async () => {
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession() {
        return sessionSpy();
      },
    }));
    const launch = { requestId: "start-owned", controlEpoch: 3, launchId: "launch-owned" };
    const options = {
      agentWorkspaceDirectory: join(testWorkspaceRoot, "launch-owned", "agent-1"),
      runtimeId: launch.launchId,
      serverLaunch: launch,
    };
    try {
      await manager.start("agent-1", config, options);
      expect(manager.serverLaunch("agent-1")).toEqual(launch);
      manager.recordClientSeq("agent-1", 7);
      await manager.release("agent-1", 1_000);
      await manager.start("agent-1", config, options);
      expect(manager.serverLaunch("agent-1")).toEqual(launch);
      expect(manager.lastClientSeq("agent-1")).toBe(7);
      await manager.stop("agent-1");
      expect(manager.serverLaunch("agent-1")).toBeUndefined();
      expect(manager.lastClientSeq("agent-1")).toBe(0);
    } finally {
      await manager.shutdown();
    }
  });

  test("a failed provider start does not register its server launch identity", async () => {
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession() {
        throw new Error("provider refused launch");
      },
    }));
    await expect(
      manager.start("agent-1", config, {
        agentWorkspaceDirectory: join(testWorkspaceRoot, "launch-refused", "agent-1"),
        serverLaunch: { requestId: "refused", controlEpoch: 4, launchId: "launch-refused" },
      }),
    ).rejects.toThrow("provider refused launch");
    expect(manager.serverLaunch("agent-1")).toBeUndefined();
    expect(manager.restartConfig("agent-1")).toBeUndefined();
    expect(manager.runningAgentIds()).toEqual([]);
  });

  test("starts one runtime with its configuration and stops it", async () => {
    const session = sessionSpy();
    let startedOptions: AgentSessionOptions | undefined;
    const adapter: CodeAgentProvider = {
      provider: "pi",
      async createAgentSession(options) {
        startedOptions = options;
        return session;
      },
    };
    const probedPaths: (string | undefined)[] = [];
    const manager = new AgentProcessManager(
      () => adapter,
      async (path) => {
        probedPaths.push(path);
        return { kind: "config-hook" };
      },
    );

    const workspace = join(testWorkspaceRoot, "a", "agents", "agent-1");
    const runtime = await manager.start("agent-1", config, {
      agentWorkspaceDirectory: workspace,
    });

    expect(runtime.config).toEqual(config);
    expect(runtime.session).toBe(session);
    expect(startedOptions).toEqual({
      agentId: "agent-1",
      agentWorkspaceDirectory: workspace,
      environment: undefined,
      instructions: expect.stringContaining(`- Agent workspace: ${workspace}`),
      sessionId: undefined,
      runtime: config,
      gitHooks: { kind: "config-hook" },
    });
    // The commit trailer hook is probed once per launch, against the Agent's own PATH.
    expect(probedPaths).toHaveLength(1);
    expect(probedPaths[0]).toBeTruthy();
    if (!startedOptions) throw new Error("provider was not started");
    expect(startedOptions.instructions.match(/^## Current Runtime Context$/gm)).toHaveLength(1);
    expect(startedOptions.instructions.match(/^- Agent workspace: /gm)).toHaveLength(1);
    expect(startedOptions.instructions.split(workspace)).toHaveLength(2);
    expect(startedOptions.instructions).toContain("## CoForge communication");
    expect(startedOptions.instructions).toContain("coforge message send");
    expect(manager.size).toBe(1);
    expect(manager.status("agent-1")).toBe("active");
    expect(manager.status("agent-2")).toBe("inactive");
    expect(manager.activeAgentIds()).toEqual(["agent-1"]);
    expect(manager.runningAgentIds()).toEqual(["agent-1"]);
    await manager.stop("agent-1");
    expect(session.disposeCalls).toBe(1);
    expect(manager.size).toBe(0);
    expect(manager.status("agent-1")).toBe("inactive");
    expect(manager.activeAgentIds()).toEqual([]);
    expect(manager.runningAgentIds()).toEqual([]);
  });

  test("retains provider configuration for the provider launch", async () => {
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession() {
        return sessionSpy();
      },
    }));
    const credentialConfig = {
      ...config,
      providerConfig: {
        kind: "coforge" as const,
        providerId: "deepseek",
        apiKey: "sk-deepseek-secret",
      },
    };

    const runtime = await manager.start("agent-credential", credentialConfig, {
      agentWorkspaceDirectory: join(testWorkspaceRoot, "credential", "agent-credential"),
    });

    expect(runtime.config.providerConfig).toEqual({
      kind: "coforge",
      providerId: "deepseek",
      apiKey: "sk-deepseek-secret",
    });
    await manager.stop("agent-credential");
  });

  test("creates the Agent workspace before starting its provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "coforge-agent-runtime-"));
    const workspace = join(root, "workspace", "agents", "agent-1");
    let directoryExistsAtStart = false;
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession() {
        directoryExistsAtStart = (await stat(workspace)).isDirectory();
        return sessionSpy();
      },
    }));

    try {
      await manager.start("agent-1", config, {
        agentWorkspaceDirectory: workspace,
      });
      expect(directoryExistsAtStart).toBe(true);
    } finally {
      await manager.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("seeds MEMORY.md into the Agent workspace on start, using the server-authored identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "coforge-agent-memory-seed-manager-"));
    const workspace = join(root, "agents", "agent-1");
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession() {
        return sessionSpy();
      },
    }));

    try {
      await manager.start("agent-1", config, {
        agentWorkspaceDirectory: workspace,
        assignedSkillPacks: [],
        identity: { name: "scout", displayName: "Scout", description: "Reviews pull requests." },
      });
      const content = await readFile(join(workspace, "MEMORY.md"), "utf8");
      expect(content).toBe(
        buildInitialMemoryMd({
          name: "scout",
          displayName: "Scout",
          description: "Reviews pull requests.",
        }),
      );
    } finally {
      await manager.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("Memory Agent launch does not seed MEMORY.md or install assigned skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "coforge-memory-agent-no-pi-inject-"));
    const workspace = join(root, "agents", "memory");
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession() {
        return sessionSpy();
      },
    }));
    try {
      await manager.start(
        "memory",
        { ...config, toolProfile: "openviking-memory" },
        {
          agentWorkspaceDirectory: workspace,
          assignedSkillPacks: ["weekly-report"],
          identity: { name: "memory", displayName: "Memory", description: "Team memory." },
        },
      );
      await expect(stat(join(workspace, "MEMORY.md"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(workspace, ".pi", "skills"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await manager.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("eval host-Pi isolation skips MEMORY.md for every channel Agent, not only Memory Agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "coforge-eval-no-pi-inject-"));
    const workspace = join(root, "agents", "task");
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession() {
        return sessionSpy();
      },
    }));
    try {
      await manager.start("task", config, {
        agentWorkspaceDirectory: workspace,
        environment: { COFORGE_EVAL_DISABLE_HOST_PI_INJECTION: "1" },
        assignedSkillPacks: ["weekly-report"],
        identity: { name: "task", displayName: "Task" },
      });
      await expect(stat(join(workspace, "MEMORY.md"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(workspace, ".pi", "skills"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await manager.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a second start leaves an Agent-modified MEMORY.md alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "coforge-agent-memory-seed-preserve-"));
    const workspace = join(root, "agents", "agent-1");
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession() {
        return sessionSpy();
      },
    }));

    try {
      await manager.start("agent-1", config, {
        agentWorkspaceDirectory: workspace,
        assignedSkillPacks: [],
        identity: {
          name: "scout",
        },
      });
      await manager.stop("agent-1");
      const memoryPath = join(workspace, "MEMORY.md");
      const ownedContent = "# Scout\n\n## Role\nKnowledge the Agent accumulated on its own.\n";
      await writeFile(memoryPath, ownedContent, { encoding: "utf8" });

      await manager.start("agent-1", config, {
        agentWorkspaceDirectory: workspace,
        assignedSkillPacks: [],
        identity: {
          name: "scout",
          description: "A brand-new description that must not overwrite the file above.",
        },
      });

      expect(await readFile(memoryPath, "utf8")).toBe(ownedContent);
    } finally {
      await manager.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stays active when the Agent runtime process exits unexpectedly", async () => {
    const session = sessionSpy();
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession() {
        return session;
      },
    }));

    await manager.start("agent-1", config, {
      agentWorkspaceDirectory: join(testWorkspaceRoot, "exit", "agent-1"),
    });
    session.exit();

    expect(manager.status("agent-1")).toBe("active");
    expect(manager.restartConfig("agent-1")).toEqual({ config, sessionId: undefined });
    expect(manager.activeAgentIds()).toEqual(["agent-1"]);
    expect(manager.runningAgentIds()).toEqual([]);
    await manager.stop("agent-1");
    expect(manager.status("agent-1")).toBe("inactive");
    expect(manager.restartConfig("agent-1")).toBeUndefined();
  });

  test("starts multiple Agent runtimes for distinct Agents", async () => {
    let starts = 0;
    const adapter: CodeAgentProvider = {
      provider: "pi",
      async createAgentSession() {
        starts += 1;
        return sessionSpy();
      },
    };
    const manager = new AgentProcessManager(() => adapter);

    await manager.start("agent-1", config, {
      agentWorkspaceDirectory: join(testWorkspaceRoot, "multiple", "agent-1"),
    });
    await manager.start("agent-2", config, {
      agentWorkspaceDirectory: join(testWorkspaceRoot, "multiple", "agent-2"),
    });
    expect(starts).toBe(2);
    expect(manager.size).toBe(2);
  });

  test("passes a session id through the provider-neutral start seam", async () => {
    let options: { sessionId?: string } | undefined;
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession(startOptions) {
        options = startOptions;
        return sessionSpy();
      },
    }));
    await manager.start("agent-1", config, {
      agentWorkspaceDirectory: join(testWorkspaceRoot, "session", "agent-1"),
      sessionId: "session-7",
    });
    expect(options?.sessionId).toBe("session-7");
  });

  test("threads the server-authored identity through to the standing instructions", async () => {
    let options: { instructions: string } | undefined;
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession(startOptions) {
        options = startOptions;
        return sessionSpy();
      },
    }));
    await manager.start("agent-1", config, {
      agentWorkspaceDirectory: join(testWorkspaceRoot, "identity", "agent-1"),
      assignedSkillPacks: [],
      identity: { name: "scout", runtimeContext: { computerName: "Builder Box" } },
    });
    expect(options?.instructions).toContain('You are "scout", an AI agent in CoForge');
    expect(options?.instructions).toContain("- Computer: Builder Box");
  });

  test("does not retain a runtime when provider startup fails", async () => {
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession() {
        throw new Error("startup failed");
      },
    }));

    await expect(
      manager.start("agent-1", config, {
        agentWorkspaceDirectory: join(testWorkspaceRoot, "failure", "agent-1"),
      }),
    ).rejects.toThrow("startup failed");
    expect(manager.size).toBe(0);
  });

  test("blocks replacement when failed startup cannot confirm process-tree cleanup", async () => {
    let starts = 0;
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession() {
        starts++;
        throw new AgentProcessCleanupError();
      },
    }));
    const workspace = join(testWorkspaceRoot, "startup-cleanup", "agent-1");

    await expect(
      manager.start("agent-1", config, {
        agentWorkspaceDirectory: workspace,
      }),
    ).rejects.toThrow("process tree did not exit");
    await expect(
      manager.start("agent-1", config, {
        agentWorkspaceDirectory: workspace,
      }),
    ).rejects.toThrow("stopping");
    expect(starts).toBe(1);
  });

  test("rejects a replacement start until stop confirms the old session exited", async () => {
    let release!: () => void;
    const exited = new Promise<void>((resolve) => (release = resolve));
    const session = sessionSpy();
    session.dispose = async () => {
      session.disposeCalls += 1;
      await exited;
      session.exit();
    };
    let starts = 0;
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession() {
        starts++;
        return session;
      },
    }));
    const workspace = join(testWorkspaceRoot, "replacement", "agent-1");
    await manager.start("agent-1", config, {
      agentWorkspaceDirectory: workspace,
    });
    const stopping = manager.stop("agent-1");
    await expect(
      manager.start("agent-1", config, {
        agentWorkspaceDirectory: workspace,
      }),
    ).rejects.toThrow("stopping");
    expect(starts).toBe(1);
    release();
    await stopping;
    await manager.start("agent-1", config, {
      agentWorkspaceDirectory: workspace,
    });
    expect(starts).toBe(2);
  });

  test("rejects a replacement start when process-tree termination remains unresolved", async () => {
    const session = sessionSpy();
    session.dispose = async () => {
      session.disposeCalls += 1;
      session.exit();
      throw new Error("tree did not exit");
    };
    let starts = 0;
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession() {
        starts++;
        return session;
      },
    }));
    const workspace = join(testWorkspaceRoot, "unresolved", "agent-1");
    await manager.start("agent-1", config, {
      agentWorkspaceDirectory: workspace,
    });

    await expect(manager.stop("agent-1")).rejects.toThrow("tree did not exit");
    await expect(
      manager.start("agent-1", config, {
        agentWorkspaceDirectory: workspace,
      }),
    ).rejects.toThrow("stopping");
    expect(starts).toBe(1);
    expect(manager.status("agent-1")).toBe("active");
  });

  test("release ends the process but keeps what a later wake needs, reporting stopping meanwhile", async () => {
    const session = sessionSpy();
    const exit = Promise.withResolvers<void>();
    session.dispose = async function () {
      this.disposeCalls += 1;
      await exit.promise;
      this.exit();
    };
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession() {
        return session;
      },
    }));
    await manager.start("agent-1", config, {
      agentWorkspaceDirectory: join(testWorkspaceRoot, "release", "agent-1"),
    });
    manager.rememberServerLaunch("agent-1", {
      requestId: "start-1",
      controlEpoch: 1,
      launchId: "launch-1",
    });
    manager.recordClientSeq("agent-1", 7);

    const released = manager.release("agent-1", 1_000);
    expect(manager.isStopping("agent-1")).toBe(true);
    exit.resolve();
    await released;

    expect(manager.isStopping("agent-1")).toBe(false);
    expect(manager.session("agent-1")).toBeUndefined();
    expect(manager.restartConfig("agent-1")).toMatchObject({ config });
    expect(manager.serverLaunch("agent-1")).toMatchObject({ launchId: "launch-1" });
    expect(manager.lastClientSeq("agent-1")).toBe(7);
    expect(manager.status("agent-1")).toBe("active");
  });

  test("a release whose process will not exit in time rejects and leaves the runtime registered", async () => {
    const session = sessionSpy();
    session.dispose = () => new Promise<void>(() => {});
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession() {
        return session;
      },
    }));
    await manager.start("agent-1", config, {
      agentWorkspaceDirectory: join(testWorkspaceRoot, "release-hang", "agent-1"),
    });

    await expect(manager.release("agent-1", 10)).rejects.toThrow("did not exit");
    expect(manager.session("agent-1")).toBe(session);
    expect(manager.isStopping("agent-1")).toBe(false);
  });

  test("a stop during a release waits for it, then forgets the Agent as usual", async () => {
    const session = sessionSpy();
    const exit = Promise.withResolvers<void>();
    session.dispose = async function () {
      this.disposeCalls += 1;
      await exit.promise;
      this.exit();
    };
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession() {
        return session;
      },
    }));
    await manager.start("agent-1", config, {
      agentWorkspaceDirectory: join(testWorkspaceRoot, "release-stop", "agent-1"),
    });

    const released = manager.release("agent-1", 1_000);
    const stopped = manager.stop("agent-1");
    exit.resolve();
    await Promise.all([released, stopped]);

    expect(session.disposeCalls).toBe(1);
    expect(manager.restartConfig("agent-1")).toBeUndefined();
    expect(manager.status("agent-1")).toBe("inactive");
  });
});

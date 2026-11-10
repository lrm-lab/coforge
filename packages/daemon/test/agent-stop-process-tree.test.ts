import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_STOP_SWEEP_DEADLINE_MS } from "#src/agent-runtime/agent-stop";
import { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import { AGENT_LAUNCH_TAG_ENV, agentLaunchTag } from "#src/platform/agent-launch-tag";
import type { AgentRuntimeConfig, AgentSession } from "@coforge/agent";

const config: AgentRuntimeConfig = { provider: "pi", model: "default", reasoning: "balanced" };
const workspaceRoot = join(tmpdir(), `coforge-stop-tree-${crypto.randomUUID()}`);
afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));

const DEADLINE_MS = 100;

/** A provider whose teardown never answers, standing in for one the Agent's process outlives. */
function wedgedSession(): AgentSession {
  return {
    async sendMessage() {},
    subscribe: () => () => undefined,
    async interrupt() {},
    onExit: () => () => undefined,
    dispose: () => new Promise<void>(() => {}),
  };
}

async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test(
  "a stop kills the launch-tagged process that ignores SIGTERM and then completes",
  async () => {
    const agentId = crypto.randomUUID();
    const tag = agentLaunchTag(agentId, crypto.randomUUID());
    // The Agent's process: it shrugs off SIGTERM and would live forever.
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      env: { ...Bun.env, [AGENT_LAUNCH_TAG_ENV]: tag },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const manager = new AgentProcessManager(
      () => ({ provider: "pi", createAgentSession: async () => wedgedSession() }),
      undefined,
      undefined,
      undefined,
      { deadlineMs: DEADLINE_MS },
    );
    try {
      await manager.start(agentId, config, {
        agentWorkspaceDirectory: join(workspaceRoot, "tree"),
      });
      expect(await alive(child.pid)).toBe(true);

      await manager.stop(agentId);

      expect(manager.runningAgentIds()).toEqual([]);
      await child.exited;
      expect(await alive(child.pid)).toBe(false);
      expect(child.signalCode).toBe("SIGKILL");
    } finally {
      child.kill("SIGKILL");
      await manager.shutdown();
    }
  },
  DEADLINE_MS + AGENT_STOP_SWEEP_DEADLINE_MS + 10_000,
);

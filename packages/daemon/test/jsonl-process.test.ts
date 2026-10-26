import { afterEach, expect, test } from "bun:test";
import { ClaudeCodeProvider } from "#src/code-agent/claude-code/factory";
import { TEST_AGENT_INSTRUCTIONS } from "./fixtures/claude-feed";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";

import { JsonlProcess } from "@lrm/coforge-anvil/execution";
import { type OwnedProcessTree } from "@lrm/coforge-anvil";
import { ProcessTreeOwner } from "#src/platform/process-tree";
import { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import type { AgentSession } from "@coforge/agent";

const agentWorkspaces: string[] = [];
afterEach(async () => {
  await Promise.all(
    agentWorkspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })),
  );
});

/** An Agent workspace path the manager may create, removed after the test. */
function agentWorkspace(name: string): string {
  const workspace = `${tmpdir()}/coforge-${name}-${crypto.randomUUID()}`;
  agentWorkspaces.push(workspace);
  return workspace;
}

test("startup spawn failure permits the manager to retry", async () => {
  let starts = 0;
  const manager = new AgentProcessManager(() => ({
    provider: "pi",
    async createAgentSession() {
      starts++;
      return sessionFor(
        new JsonlProcess(
          [`coforge-missing-${crypto.randomUUID()}`],
          tmpdir(),
          {
            PATH: globalThis.process.env.PATH ?? "",
          },
          new ProcessTreeOwner(),
        ),
      );
    },
  }));
  const runtime = { provider: "pi", model: "default", reasoning: "balanced" } as const;
  const workspace = agentWorkspace("startup-failure");

  await expect(
    manager.start("agent-1", runtime, {
      agentWorkspaceDirectory: workspace,
    }),
  ).rejects.toThrow("Executable not found");
  expect(manager.size).toBe(0);

  await expect(
    manager.start("agent-1", runtime, {
      agentWorkspaceDirectory: workspace,
    }),
  ).rejects.toThrow("Executable not found");
  expect(starts).toBe(2);
});

test("startup cleanup probe failure blocks a replacement", async () => {
  const tree = {
    child: {
      pid: 1,
      exited: Promise.resolve(1),
      exitCode: 1,
      stdin: { write: () => true, end: () => undefined, flush: async () => undefined },
      stdout: { async *[Symbol.asyncIterator]() {} },
      stderr: { async *[Symbol.asyncIterator]() {} },
      kill: () => undefined,
    },
    terminate: async () => undefined,
    waitForExit: async () => {
      throw new Error("process inspection unavailable");
    },
  } satisfies OwnedProcessTree;
  let starts = 0;
  const manager = new AgentProcessManager(() => ({
    provider: "pi",
    async createAgentSession() {
      starts++;
      const process = new JsonlProcess(["unused"], tmpdir(), {}, { spawn: () => tree });
      await process.dispose();
      return sessionFor(process);
    },
  }));
  const runtime = { provider: "pi", model: "default", reasoning: "balanced" } as const;
  const workspace = agentWorkspace("startup-probe");

  await expect(
    manager.start("agent-1", runtime, {
      agentWorkspaceDirectory: workspace,
    }),
  ).rejects.toThrow("process tree did not exit");
  await expect(
    manager.start("agent-1", runtime, {
      agentWorkspaceDirectory: workspace,
    }),
  ).rejects.toThrow("stopping");
  expect(starts).toBe(1);
});

test.skipIf(process.platform === "win32")(
  "dispose terminates and reaps a direct process with long-lived descendants",
  async () => {
    const owner = new ProcessTreeOwner();
    let directExited: Promise<number> | undefined;
    const process = new JsonlProcess(
      [globalThis.process.execPath, `${import.meta.dir}/fixtures/process-tree.ts`],
      import.meta.dir,
      Object.fromEntries(
        Object.entries(globalThis.process.env).filter((entry): entry is [string, string] =>
          Boolean(entry[1]),
        ),
      ),
      {
        spawn(command, cwd, environment) {
          const tree = owner.spawn(command, cwd, environment);
          directExited = tree.child.exited;
          return tree;
        },
      } as ProcessTreeOwner,
    );
    const observedPids = new Promise<{ childPid: number; grandchildPid: number }>((resolve) => {
      process.onRecord((record) => resolve(record as { childPid: number; grandchildPid: number }));
    });
    const { childPid, grandchildPid } = await observedPids;
    try {
      await process.dispose();
      expect(await directExited).toBeNumber();
      expect(pidExists(childPid)).toBe(false);
      expect(pidExists(grandchildPid)).toBe(false);
    } finally {
      killIfPresent(childPid);
      killIfPresent(grandchildPid);
      await process.dispose();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "unexpected direct exit closes only after descendants exit and then permits replacement",
  async () => {
    const environment = Object.fromEntries(
      Object.entries(globalThis.process.env).filter((entry): entry is [string, string] =>
        Boolean(entry[1]),
      ),
    );
    let starts = 0;
    let pids: { childPid: number; grandchildPid: number } | undefined;
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession() {
        starts++;
        const process = new JsonlProcess(
          [globalThis.process.execPath, `${import.meta.dir}/fixtures/process-tree.ts`],
          import.meta.dir,
          { ...environment, EXIT_DIRECT: "1" },
          new ProcessTreeOwner(),
        );
        process.onRecord((record) => (pids = record as typeof pids));
        return sessionFor(process);
      },
    }));
    const runtime = { provider: "pi", model: "default", reasoning: "balanced" } as const;
    const workspace = agentWorkspace("unexpected-exit");

    await manager.start("agent-1", runtime, {
      agentWorkspaceDirectory: workspace,
    });
    await waitUntil(() => pids !== undefined);
    await waitUntil(() => manager.session("agent-1") === undefined);
    expect(manager.status("agent-1")).toBe("active");
    expect(pidExists(pids!.childPid)).toBe(false);
    expect(pidExists(pids!.grandchildPid)).toBe(false);
    await manager.start("agent-1", runtime, {
      agentWorkspaceDirectory: workspace,
    });
    expect(starts).toBe(2);
    await manager.shutdown();
  },
  10_000,
);

test("failed unexpected-exit tree cleanup does not close or permit replacement", async () => {
  const exited = Promise.resolve(17);
  let failures = 0;
  let closes = 0;
  const tree = {
    child: {
      pid: 1,
      exited,
      exitCode: 17,
      stdin: { write: () => true, end: () => undefined, flush: async () => undefined },
      stdout: { async *[Symbol.asyncIterator]() {} },
      stderr: { async *[Symbol.asyncIterator]() {} },
      kill: () => undefined,
    },
    terminate: async () => undefined,
    waitForExit: async () => false,
  } satisfies OwnedProcessTree;
  const process = new JsonlProcess(["unused"], tmpdir(), {}, { spawn: () => tree });
  process.onFailure(() => failures++);
  process.onClose(() => closes++);
  let starts = 0;
  const manager = new AgentProcessManager(() => ({
    provider: "pi",
    async createAgentSession() {
      starts++;
      return sessionFor(process);
    },
  }));
  const runtime = { provider: "pi", model: "default", reasoning: "balanced" } as const;
  const workspace = agentWorkspace("failed-cleanup");

  await manager.start("agent-1", runtime, {
    agentWorkspaceDirectory: workspace,
  });
  await waitUntil(() => failures > 0);
  expect(closes).toBe(0);
  await expect(
    manager.start("agent-1", runtime, {
      agentWorkspaceDirectory: workspace,
    }),
  ).rejects.toThrow("active");
  expect(starts).toBe(1);
  expect(manager.status("agent-1")).toBe("active");
});

function sessionFor(process: JsonlProcess): AgentSession {
  return {
    sendMessage: async (message) => process.send({ message }),
    subscribe: () => () => undefined,
    interrupt: async () => process.interrupt(),
    onExit: (listener) => process.onClose(listener),
    dispose: () => process.dispose(),
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("condition was not met");
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    }
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ESRCH") return false;
    throw error;
  }
}

function killIfPresent(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as { code?: string }).code !== "ESRCH") throw error;
  }
}

test("Claude Code startup fails when its CLI does not complete initialization", async () => {
  const adapter = new ClaudeCodeProvider({
    command: [process.execPath, anvilRuntimeFixtures.invalidJsonl],
  });

  await expect(
    Promise.race([
      adapter.createAgentSession({
        agentWorkspaceDirectory: tmpdir(),
        instructions: TEST_AGENT_INSTRUCTIONS,
      }),
      // Process startup can exceed 200ms on a cold Bun worker even though the fixture
      // immediately emits malformed JSONL; keep the assertion about the protocol error while
      // avoiding a startup-scheduling race.
      Bun.sleep(1_000).then(() => {
        throw new Error("startup timed out");
      }),
    ]),
  ).rejects.toThrow("invalid output");
});

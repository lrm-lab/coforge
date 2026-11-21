import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonRuntime, type DaemonConfig } from "#src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { cleanupOwnedTree } from "@lrm/coforge-anvil/execution";
import type { AgentControlResult, AgentStartIntent } from "@lrm/coforge-sdk/internal";
import { ProcessTreeOwner } from "#src/platform/process-tree";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";
import { captureDaemonLogs } from "./log-capture";

const tempRoot = realpathSync(tmpdir());
const connection: DaemonConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: join(tempRoot, `coforge-stop-first-turn-${crypto.randomUUID()}`),
};
afterAll(() => rm(connection.workspaceRoot, { recursive: true, force: true }));

function start(requestId: string, epoch: number, launchId: string): AgentStartIntent {
  return {
    protocolMajor: 1,
    requestId,
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    agentId: "agent-a",
    provider: "claude-code",
    model: "default",
    reasoning: "balanced",
    controlEpoch: epoch,
    launchId,
    unreadSummary: { "#ops": 3 },
  };
}

function stop(requestId: string, epoch: number) {
  return {
    protocolMajor: 1,
    requestId,
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    agentId: "agent-a",
    provider: "claude-code",
    controlEpoch: epoch,
  } as const;
}

const within = <T>(ms: number, work: Promise<T>) =>
  Promise.race([
    work,
    Bun.sleep(ms).then(() => {
      throw new Error(`still waiting after ${ms} ms`);
    }),
  ]);

async function runtimeWith({
  answers,
  onDispose,
}: {
  answers: boolean;
  onDispose?: () => Promise<void>;
}) {
  const stateDirectory = join(tempRoot, `coforge-stop-first-turn-state-${crypto.randomUUID()}`);
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const results: AgentControlResult[] = [];
  let sessions = 0;
  let disposed = 0;
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "claude-code",
      async createAgentSession() {
        sessions++;
        const listeners = new Set<(event: AgentRuntimeEvent) => void>();
        const exits = new Set<() => void>();
        const turn = Promise.withResolvers<void>();
        void turn.promise.catch(() => undefined);
        const runTurn = async () => {
          if (answers)
            queueMicrotask(() => {
              for (const listener of listeners)
                listener({ type: "tool-start", id: "t1", name: "Bash" } as AgentRuntimeEvent);
            });
          await turn.promise;
        };
        return {
          sendMessage: runTurn,
          notify: runTurn,
          subscribe(listener: (event: AgentRuntimeEvent) => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async interrupt() {},
          readSessionIdentity: async () => ({
            sessionId: "session-a",
            state: "resumable" as const,
          }),
          onExit(listener: () => void) {
            exits.add(listener);
            return () => exits.delete(listener);
          },
          async dispose() {
            disposed++;
            await onDispose?.();
            turn.reject(new Error("Agent runtime is stopping"));
            for (const exit of exits) exit();
          },
        };
      },
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        async requestAgentLaunchConfig() {
          return { agentApiKey: `sk_agent_${"a".repeat(43)}` };
        },
        async revokeAgentApiKey() {},
        sendAgentActivity() {},
        async sendAgentControlResult(result: AgentControlResult) {
          results.push(result);
        },
        async reportAgentSession() {},
        async sendAgentDeliveryAck() {},
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    stateDirectory,
  );
  const close = async () => {
    try {
      await runtime.stop();
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  };
  try {
    await runtime.start(connection);
  } catch (error) {
    await close();
    throw error;
  }
  return {
    runtime,
    results,
    sessions: () => sessions,
    disposed: () => disposed,
    phases: (requestId: string) =>
      results.filter((result) => result.requestId === requestId).map((result) => result.phase),
    close,
  };
}

test("a Start carrying unread messages is started once the model answers, while its first turn still runs", async () => {
  const h = await runtimeWith({ answers: true });
  try {
    await within(2_000, runtime(h).handleAgentStart(start("start-1", 1, "launch-1")));
    expect(h.phases("start-1")).toContain("started");
    expect(h.disposed()).toBe(0);
  } finally {
    await h.close();
  }
});

test("a Stop during that first turn ends the process in seconds, and nothing launches it again", async () => {
  const h = await runtimeWith({ answers: true });
  try {
    await within(2_000, runtime(h).handleAgentStart(start("start-1", 1, "launch-1")));
    await within(2_000, runtime(h).handleAgentStop(stop("stop-1", 2)));
    expect(h.phases("stop-1")).toContain("stopped");
    expect(h.disposed()).toBe(1);
    await Bun.sleep(50);
    expect(h.sessions()).toBe(1);
  } finally {
    await h.close();
  }
});

test("a newer Start during that first turn is not held behind it", async () => {
  const h = await runtimeWith({ answers: true });
  try {
    await within(2_000, runtime(h).handleAgentStart(start("start-1", 1, "launch-1")));
    await within(2_000, runtime(h).handleAgentStart(start("start-2", 2, "launch-2")));
    expect(h.phases("start-2")).toContain("started");
  } finally {
    await h.close();
  }
});

test("a Stop of a launch that never answers ends it in seconds, logs the preemption, and nothing launches it again", async () => {
  const h = await runtimeWith({ answers: false });
  try {
    const { records } = await captureDaemonLogs(async () => {
      const starting = runtime(h).handleAgentStart(start("start-1", 1, "launch-1"));
      void starting.catch(() => undefined);
      await Bun.sleep(20);
      await within(2_000, runtime(h).handleAgentStop(stop("stop-1", 2)));
      await starting.catch(() => undefined);
      await Bun.sleep(50);
    });
    expect(h.phases("stop-1")).toContain("stopped");
    expect(h.phases("start-1")).not.toContain("started");
    expect(h.sessions()).toBe(1);
    const preempted = records.find(
      (record) => record.properties.event === "agent_control:launch_preempted",
    );
    expect(preempted?.properties).toMatchObject({
      agent_id: "agent-a",
      launch_id: "launch-1",
      start_epoch: 1,
      stop_epoch: 2,
    });
    expect(
      records.some((record) => record.properties.event === "agent_control:launch_retry_scheduled"),
    ).toBe(false);
  } finally {
    await h.close();
  }
});

test("a Stop older than the launch in progress does not end it", async () => {
  const h = await runtimeWith({ answers: false });
  try {
    const { records } = await captureDaemonLogs(async () => {
      void runtime(h)
        .handleAgentStart(start("start-2", 2, "launch-2"))
        .catch(() => undefined);
      await Bun.sleep(20);
      void runtime(h)
        .handleAgentStop(stop("stop-1", 1))
        .catch(() => undefined);
      await Bun.sleep(50);
    });
    expect(
      records.some((record) => record.properties.event === "agent_control:launch_preempted"),
    ).toBe(false);
    expect(h.disposed()).toBe(0);
  } finally {
    await h.close();
  }
});

type StopFixture = {
  directory: string;
  readyFile: string;
  tree: ReturnType<ProcessTreeOwner["spawn"]>;
};

async function closeStopFixtureProcess(tree: StopFixture["tree"]) {
  if (!(await tree.waitForExit(0))) await tree.terminate(true);
  if (!(await tree.waitForExit(2_000))) throw new Error("Stop fixture process survived cleanup");
  await tree.child.exited;
}

async function withSigtermIgnoringFixture(run: (fixture: StopFixture) => Promise<void>) {
  const directory = await mkdtemp(join(tempRoot, "coforge-stop-sigterm-"));
  try {
    const readyFile = join(directory, "ignoring-sigterm");
    const tree = new ProcessTreeOwner().spawn(
      [
        process.execPath,
        "-e",
        `process.on('SIGTERM', () => {}); await Bun.write(${JSON.stringify(readyFile)}, ''); setInterval(() => {}, 1000)`,
      ],
      directory,
      { PATH: process.env.PATH ?? "" },
    );
    try {
      await run({ directory, readyFile, tree });
    } finally {
      await closeStopFixtureProcess(tree);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a Stop of a process that ignores SIGTERM returns stopped within 20 seconds", async () => {
  await withSigtermIgnoringFixture(async ({ tree, readyFile }) => {
    await waitForReadyFile(readyFile);
    const h = await runtimeWith({
      answers: true,
      onDispose: () => cleanupOwnedTree(tree, tree.child),
    });
    try {
      await within(2_000, runtime(h).handleAgentStart(start("start-1", 1, "launch-1")));
      await within(20_000, runtime(h).handleAgentStop(stop("stop-1", 2)));
      expect(h.phases("stop-1")).toContain("stopped");
      expect(await tree.waitForExit(0)).toBe(true);
      await tree.child.exited;
      if (process.platform !== "win32") expect(tree.child.exitSignal).toBe("SIGKILL");
    } finally {
      await h.close();
    }
  });
}, 25_000);

for (const failure of ["waiting for readiness", "starting the runtime"] as const) {
  test(`the Stop fixture cleans up its process and files after failing while ${failure}`, async () => {
    let spawned: StopFixture | undefined;
    await expect(
      withSigtermIgnoringFixture(async (fixture) => {
        spawned = fixture;
        if (failure === "waiting for readiness") {
          await waitForReadyFile(join(fixture.directory, "missing"), 0);
        } else {
          await waitForReadyFile(fixture.readyFile);
          throw new Error("runtime startup failed");
        }
      }),
    ).rejects.toThrow(
      failure === "waiting for readiness" ? "ready file did not appear" : "runtime startup failed",
    );
    expect(spawned?.directory).toBeDefined();
    const { tree, directory, readyFile } = spawned!;
    expect(await tree.waitForExit(0)).toBe(true);
    expect(await Bun.file(readyFile).exists()).toBe(false);
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);
}

function runtime(h: { runtime: DaemonRuntime }) {
  return h.runtime;
}

async function waitForReadyFile(path: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await Bun.file(path).exists())) {
    if (Date.now() >= deadline) throw new Error("Stop fixture ready file did not appear");
    await Bun.sleep(10);
  }
}

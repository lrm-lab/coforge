import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import { controlIntentPorts, handleAgentStart } from "#src/daemon-runtime/runtime-agent-flows";
import type { AgentRuntimeConfig, AgentSession } from "@coforge/agent";

const config: AgentRuntimeConfig = { provider: "pi", model: "default", reasoning: "balanced" };
const root = join(tmpdir(), `coforge-start-during-release-${crypto.randomUUID()}`);
afterAll(() => rm(root, { recursive: true, force: true }));

/** A manager with one running Agent whose process exit is held open by `exit`. */
async function running(exit: Promise<void>, dispose = true) {
  const exitListeners = new Set<() => void>();
  const session = {
    async sendMessage() {},
    subscribe: () => () => undefined,
    async interrupt() {},
    onExit(listener: () => void) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    async dispose() {
      await exit;
      if (dispose) for (const listener of exitListeners) listener();
    },
  } satisfies AgentSession;
  const manager = new AgentProcessManager(() => ({
    provider: "pi",
    async createAgentSession() {
      return session;
    },
  }));
  await manager.start("agent-1", config, { agentWorkspaceDirectory: join(root, "agent-1") });
  return manager;
}

test("a process being released is not one a Start may adopt", async () => {
  const exit = Promise.withResolvers<void>();
  const manager = await running(exit.promise);
  expect(manager.isRunning("agent-1")).toBe(true);

  const released = manager.release("agent-1", 1_000);

  expect(manager.isRunning("agent-1")).toBe(false);
  expect(manager.pendingRelease("agent-1")).toBeDefined();
  exit.resolve();
  await released;
  expect(manager.isRunning("agent-1")).toBe(false);
  expect(manager.pendingRelease("agent-1")).toBeUndefined();
});

test("a release that failed leaves the process running for a Start to adopt", async () => {
  const manager = await running(new Promise<void>(() => {}), false);

  await expect(manager.release("agent-1", 10)).rejects.toThrow("did not exit");

  expect(manager.isRunning("agent-1")).toBe(true);
  expect(manager.pendingRelease("agent-1")).toBeUndefined();
});

test("a Start follows a release already under way instead of racing the process it ends", async () => {
  const exit = Promise.withResolvers<void>();
  const manager = await running(exit.promise);
  const order: string[] = [];
  const ports = controlIntentPorts({
    assertOwnIntent: () => {},
    connection: { workspaceId: "workspace-1", computerId: "computer-1" },
    started: true,
    stopping: false,
    agentControl: {
      start: async () => void order.push("start"),
      stop: async () => {},
      managed: () => true,
      resetWorkspace: async () => {},
    },
    agentSessions: { replay: async () => {} },
    processes: manager,
    stops: { pendingStop: () => undefined },
    launchCoordinator: { dropOwedRecovery: () => {} },
    startAgent: async () => {
      throw new Error("unexpected");
    },
    stopAgent: async () => {},
  } as never);
  const released = manager.release("agent-1", 1_000).then(() => order.push("released"));

  const started = handleAgentStart(ports, {
    agentId: "agent-1",
    controlEpoch: 2,
    computerId: "computer-1",
  } as never);
  await Promise.resolve();
  expect(order).toEqual([]);
  exit.resolve();
  await released;
  await started.catch(() => {});

  expect(order).toEqual(["released", "start"]);
});

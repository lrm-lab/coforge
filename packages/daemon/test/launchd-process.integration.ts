import { beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import {
  AGENT_RELAY_ROOT,
  AGENT_STARTUP_TIMEOUT_MS,
  agentRelayDirectoryPrefix,
  LaunchdProcessOwner,
  stopLaunchdAgents,
} from "#src/platform/launchd-process";
import { workspaceLaunchdIdentity } from "#src/supervisor/launchd-workspace-instance";
import { readLines } from "./fixtures/read-lines";

// Explicit invocation, macOS only, from packages/daemon:
//   mise run test:file -- ./test/launchd-process.integration.ts
// Every case bootstraps real launchd user jobs and binds relay sockets under /private/tmp, so the
// default `bun test` run does not pick this file up.
beforeAll(() => expect(process.platform).toBe("darwin"));

/** This test's own Agent job prefix: its state root is a fresh directory no Workspace shares. */
function agentPrefix(root: string): string {
  return `cn.coforge.agent.${workspaceLaunchdIdentity(root, "launchd-process-test")}.`;
}

async function relayDirectories(prefix: string): Promise<string[]> {
  const relayPrefix = agentRelayDirectoryPrefix(prefix);
  return (await readdir(AGENT_RELAY_ROOT)).filter((name) => name.startsWith(relayPrefix));
}

test("native stop lets the provider handle SIGTERM before cleanup", async () => {
  const root = await mkdtemp("/private/tmp/coforge-agent-test-");
  const prefix = agentPrefix(root);
  const owner = new LaunchdProcessOwner({
    directory: root,
    prefix,
    runner: [process.execPath, `${import.meta.dir}/fixtures/launchd-agent-runner.ts`],
  });
  const tree = owner.spawn(
    ["/bin/sh", "-c", "trap 'echo terminated; exit 0' TERM; echo ready; while :; do sleep 1; done"],
    root,
    { PATH: "/usr/bin:/bin" },
  );
  try {
    const reader = readLines(tree.child.stdout);
    expect((await reader.next()).value).toBe("ready\n");
    const terminated = reader.next();
    await tree.terminate(false);
    expect((await terminated).value).toBe("terminated\n");
    expect(await tree.waitForExit(5000)).toBe(true);
  } finally {
    await tree.terminate(true);
    await stopLaunchdAgents(prefix, root);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("Agent native root exits when its Workspace owner is killed, and the next sweep removes its relay", async () => {
  const root = await mkdtemp("/private/tmp/coforge-agent-test-");
  const prefix = agentPrefix(root);
  const parent = Bun.spawn(
    [process.execPath, `${import.meta.dir}/fixtures/launchd-agent-parent.ts`, root, prefix],
    { stdout: "pipe", stderr: "inherit" },
  );
  try {
    const first = await readLines(parent.stdout).next();
    const pid = Number(first.value?.trim());
    expect(pid).toBeGreaterThan(0);
    expect(await relayDirectories(prefix)).toHaveLength(1);
    parent.kill("SIGKILL");
    await parent.exited;
    const deadline = Date.now() + 5000;
    while (true) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      if (Date.now() >= deadline) throw new Error("Agent survived Workspace death");
      await Bun.sleep(20);
    }
    expect(() => process.kill(pid, 0)).toThrow();
    // The killed owner never ran its own cleanup; the restarted Workspace's sweep must. A sweep
    // keeps a relay younger than the startup timeout, so age it as a later restart would see it.
    const [relay] = await relayDirectories(prefix);
    expect(relay).toBeDefined();
    await stopLaunchdAgents(prefix, root);
    expect(await relayDirectories(prefix)).toEqual([relay!]);
    const settled = new Date(Date.now() - AGENT_STARTUP_TIMEOUT_MS - 60_000);
    await utimes(join(AGENT_RELAY_ROOT, relay!), settled, settled);
    await stopLaunchdAgents(prefix, root);
    expect(await relayDirectories(prefix)).toEqual([]);
  } finally {
    parent.kill("SIGKILL");
    await parent.exited;
    await stopLaunchdAgents(prefix, root);
    for (const name of await relayDirectories(prefix))
      await rm(join(AGENT_RELAY_ROOT, name), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("native Agent job preserves stdio and cleans up independently", async () => {
  const root = await mkdtemp("/private/tmp/coforge-agent-test-");
  const prefix = agentPrefix(root);
  const owner = new LaunchdProcessOwner({
    directory: root,
    prefix,
    runner: [process.execPath, `${import.meta.dir}/fixtures/launchd-agent-runner.ts`],
  });
  const tree = owner.spawn(["/bin/cat"], root, { PATH: "/usr/bin:/bin" });
  try {
    const next = readLines(tree.child.stdout).next();
    tree.child.stdin.write("hello native job\n");
    await tree.child.stdin.flush();
    expect((await next).value).toBe("hello native job\n");
    await tree.terminate(false);
    expect(await tree.waitForExit(5000)).toBe(true);
    await tree.child.exited;
  } finally {
    await tree.terminate(true);
    await stopLaunchdAgents(prefix, root);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("stopping one Agent cleans its descendants without stopping its peer", async () => {
  const root = await mkdtemp("/private/tmp/coforge-agent-test-");
  const prefix = agentPrefix(root);
  const owner = new LaunchdProcessOwner({
    directory: root,
    prefix,
    runner: [process.execPath, `${import.meta.dir}/fixtures/launchd-agent-runner.ts`],
  });
  const tree = owner.spawn(["/bin/sh", "-c", "sleep 300 & echo $!; wait"], root, {
    PATH: "/usr/bin:/bin",
  });
  const peer = owner.spawn(["/bin/cat"], root, { PATH: "/usr/bin:/bin" });
  try {
    const first = await readLines(tree.child.stdout).next();
    const descendant = Number(first.value?.trim());
    expect(descendant).toBeGreaterThan(0);
    await tree.terminate(false);
    expect(await tree.waitForExit(5000)).toBe(true);
    expect(() => process.kill(descendant, 0)).toThrow();
    const next = readLines(peer.child.stdout).next();
    peer.child.stdin.write("peer alive\n");
    await peer.child.stdin.flush();
    expect((await next).value).toBe("peer alive\n");
  } finally {
    await tree.terminate(true);
    await peer.terminate(true);
    await stopLaunchdAgents(prefix, root);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

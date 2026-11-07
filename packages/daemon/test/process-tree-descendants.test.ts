import { afterEach, beforeEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { hostProcessTable, processClockMs, ProcessTreeOwner } from "#src/platform/process-tree";

// Inside a CoForge Workspace on macOS these route spawn through launchd; the host must not decide.
const workspaceAgentVariables = [
  "COFORGE_WORKSPACE_AGENT_PREFIX",
  "COFORGE_WORKSPACE_JOB_DIRECTORY",
] as const;
const hostWorkspaceAgentValues = workspaceAgentVariables.map((name) => process.env[name]);

beforeEach(() => {
  for (const name of workspaceAgentVariables) delete process.env[name];
});

afterEach(() => {
  workspaceAgentVariables.forEach((name, index) => {
    const value = hostWorkspaceAgentValues[index];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  });
});

const env = { PATH: "/usr/bin:/bin" };

// perl is /usr/bin on macOS and Linux; setsid() moves the grandchild into its own session and
// process group while its parent chain stays intact — the shape `kill(-pid)` cannot reach.
const ESCAPE_SCRIPT = `perl -MPOSIX -e 'setsid(); exec "sleep", "30"' & echo $!; wait`;
// Same escape, but the main process loops instead of waiting, so it provably outlives the
// descendant's death.
const ESCAPE_SCRIPT_LOOP = `perl -MPOSIX -e 'setsid(); exec "sleep", "30"' & echo $!; while :; do sleep 1; done`;
// The escapee ignores SIGTERM, so the polite rung cannot take it; its parent dies on that same
// rung and the survivor is reparented before the forced rung runs (task #577 review).
const IGNORE_TERM_SCRIPT = `perl -MPOSIX -e 'setsid(); $SIG{TERM}="IGNORE"; sleep 30' & echo $!; wait`;

function alive(pid: number): boolean {
  try {
    globalThis.process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function exited(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (alive(pid)) {
    if (performance.now() >= deadline) return false;
    await Bun.sleep(20);
  }
  return true;
}

/** Spawns `sh -c '<escape> & echo $!; wait'` and returns once the grandchild leads its own group. */
async function spawnEscaped(tree: ReturnType<ProcessTreeOwner["spawn"]>) {
  const reader = (tree.child.stdout as ReadableStream<Uint8Array>).getReader();
  const { value } = await reader.read();
  const escaped = Number(new TextDecoder().decode(value).trim());
  expect(Number.isSafeInteger(escaped) && escaped > 0).toBe(true);
  // `echo $!` can precede setsid(); wait until the process table shows the escape.
  const deadline = performance.now() + 5_000;
  for (;;) {
    const entry = (await hostProcessTable.list()).find((process) => process.pid === escaped);
    if (entry?.pgid === escaped && entry.ppid === tree.child.pid) return { escaped, reader };
    if (performance.now() >= deadline)
      throw new Error(`escaped descendant ${escaped} never left the child's process group`);
    await Bun.sleep(20);
  }
}

test.skipIf(process.platform === "win32")(
  "terminate signals a descendant that escaped the child's process group",
  async () => {
    const tree = new ProcessTreeOwner().spawn(["sh", "-c", ESCAPE_SCRIPT], tmpdir(), env);
    const { escaped, reader } = await spawnEscaped(tree);
    try {
      await tree.terminate(true);
      expect(await exited(escaped)).toBe(true);
      expect(await tree.child.exited).not.toBe(0);
    } finally {
      if (alive(escaped)) globalThis.process.kill(escaped, "SIGKILL");
      await reader.cancel().catch(() => {});
      await tree.terminate(true).catch(() => {});
    }
  },
  20_000,
);

test.skipIf(process.platform === "win32")(
  "terminateForTurn kills a group-escaped descendant snapshotted while its parent lived",
  async () => {
    const fence = processClockMs();
    const tree = new ProcessTreeOwner().spawn(["sh", "-c", ESCAPE_SCRIPT], tmpdir(), env);
    const { escaped, reader } = await spawnEscaped(tree);
    try {
      // The polite rung SIGTERMs only the main process; the escaped descendant survives it but
      // stays in the turn snapshot taken while the ppid chain was intact.
      await tree.terminateForTurn!(false, fence);
      const report = await tree.terminateForTurn!(true, fence);
      expect(report.killed).toContain(escaped);
      expect(await exited(escaped)).toBe(true);
    } finally {
      if (alive(escaped)) globalThis.process.kill(escaped, "SIGKILL");
      await reader.cancel().catch(() => {});
      await tree.terminate(true).catch(() => {});
    }
  },
  20_000,
);

test.skipIf(process.platform === "win32")(
  "killTurnDescendants kills a group-escaped descendant while the parent chain is intact",
  async () => {
    const fence = processClockMs();
    const tree = new ProcessTreeOwner().spawn(["sh", "-c", ESCAPE_SCRIPT_LOOP], tmpdir(), env);
    const { escaped, reader } = await spawnEscaped(tree);
    try {
      const report = await tree.killTurnDescendants!(fence);
      expect(report.killed).toContain(escaped);
      expect(await exited(escaped)).toBe(true);
      // killTurnDescendants never touches the owned main process.
      expect(tree.child.exitCode).toBeNull();
      expect(alive(tree.child.pid!)).toBe(true);
    } finally {
      if (alive(escaped)) globalThis.process.kill(escaped, "SIGKILL");
      await reader.cancel().catch(() => {});
      await tree.terminate(true).catch(() => {});
    }
  },
  20_000,
);

test.skipIf(process.platform === "win32")(
  "terminate's forced rung still signals an escapee reparented during the polite rung",
  async () => {
    const tree = new ProcessTreeOwner().spawn(["sh", "-c", IGNORE_TERM_SCRIPT], tmpdir(), env);
    const { escaped, reader } = await spawnEscaped(tree);
    try {
      await tree.terminate(false);
      await tree.child.exited;
      // The escapee ignored TERM; once its parent is gone it is reparented and a fresh
      // descendant snapshot can no longer reach it through the ppid chain.
      const deadline = performance.now() + 5_000;
      for (;;) {
        const entry = (await hostProcessTable.list()).find((process) => process.pid === escaped);
        if (entry && entry.ppid !== tree.child.pid) break;
        if (performance.now() >= deadline)
          throw new Error(`escaped descendant ${escaped} was never reparented`);
        await Bun.sleep(20);
      }
      expect(alive(escaped)).toBe(true);
      await tree.terminate(true);
      expect(await exited(escaped)).toBe(true);
    } finally {
      if (alive(escaped)) globalThis.process.kill(escaped, "SIGKILL");
      await reader.cancel().catch(() => {});
      await tree.terminate(true).catch(() => {});
    }
  },
  20_000,
);

test.skipIf(process.platform === "win32")(
  "terminate leaves a pre-existing process alone when snapshotting descendants",
  async () => {
    const bystander = Bun.spawn({ cmd: ["sleep", "30"], stdin: "ignore", env });
    const tree = new ProcessTreeOwner().spawn(["sh", "-c", ESCAPE_SCRIPT], tmpdir(), env);
    const { escaped, reader } = await spawnEscaped(tree);
    try {
      await tree.terminate(true);
      expect(await exited(escaped)).toBe(true);
      expect(bystander.killed).toBe(false);
      expect(alive(bystander.pid!)).toBe(true);
    } finally {
      if (alive(escaped)) globalThis.process.kill(escaped, "SIGKILL");
      bystander.kill("SIGKILL");
      await Promise.all([bystander.exited, reader.cancel().catch(() => {})]);
      await tree.terminate(true).catch(() => {});
    }
  },
  20_000,
);

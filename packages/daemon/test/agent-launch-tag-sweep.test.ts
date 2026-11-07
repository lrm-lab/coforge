import { expect, test } from "bun:test";
import { agentLaunchTag } from "#src/platform/agent-launch-tag";
import {
  extractAgentLaunchTag,
  sweepAgentLaunchTags,
  type AgentLaunchTagTable,
  type TaggedProcessTableEntry,
} from "#src/platform/agent-launch-tag-sweep";
import {
  agentLaunchTagToken,
  claimAgentLaunchTagSweep,
  clearAgentLaunchTag,
  setAgentLaunchTag,
} from "#src/daemon-runtime/agent-launch-tags";

const AGENT = crypto.randomUUID();
const TOKEN = crypto.randomUUID();
const OTHER_TOKEN = crypto.randomUUID();
const OTHER_AGENT = crypto.randomUUID();

function taggedEnv(agentId = AGENT, token = TOKEN): string {
  return `PATH=/usr/bin\0HOME=/tmp\0COFORGE_AGENT_LAUNCH_TAG=${agentLaunchTag(agentId, token)}\0TERM=xterm`;
}

test("extractAgentLaunchTag reads the tag from a NUL-separated environment", () => {
  expect(extractAgentLaunchTag(taggedEnv())).toEqual({ agentId: AGENT, token: TOKEN });
});

test("extractAgentLaunchTag reads the tag from ps-rendered environment text", () => {
  const line = `sleep 600 FOO=bar COFORGE_AGENT_LAUNCH_TAG=${agentLaunchTag(AGENT, TOKEN)} BAZ=qux`;
  expect(extractAgentLaunchTag(line)).toEqual({ agentId: AGENT, token: TOKEN });
});

test("extractAgentLaunchTag ignores absent, malformed and wrong-shaped values", () => {
  expect(extractAgentLaunchTag("PATH=/usr/bin\0HOME=/tmp")).toBeUndefined();
  expect(extractAgentLaunchTag("COFORGE_AGENT_LAUNCH_TAG=not-a-tag")).toBeUndefined();
  expect(extractAgentLaunchTag(`COFORGE_AGENT_LAUNCH_TAG=${AGENT}`)).toBeUndefined();
  expect(
    extractAgentLaunchTag(`XCOFORGE_AGENT_LAUNCH_TAG=${agentLaunchTag(AGENT, TOKEN)}`),
  ).toBeUndefined();
});

function fakeTable(entries: TaggedProcessTableEntry[]) {
  const signaled: { pid: number; signal: string }[] = [];
  const dead = new Set<number>();
  const table: AgentLaunchTagTable = {
    async list() {
      return entries;
    },
    async startStamp(pid) {
      return dead.has(pid) ? undefined : entries.find((e) => e.pid === pid)?.startStamp;
    },
    async alive(pid) {
      return !dead.has(pid);
    },
    signal(pid, signal) {
      signaled.push({ pid, signal });
      if (signal === "SIGKILL") dead.add(pid);
    },
  };
  return { table, signaled, dead };
}

function entry(
  pid: number,
  tag: { agentId: string; token: string } | undefined,
  startStamp = `stamp-${pid}`,
) {
  return { pid, startStamp, tag };
}

test("the sweep collects every token this agent carries and spares only the live launch", async () => {
  const mine = entry(101, { agentId: AGENT, token: TOKEN });
  // An earlier launch's stray of the same Agent: a true stop collects it too.
  const olderLaunch = entry(102, { agentId: AGENT, token: OTHER_TOKEN });
  const otherAgent = entry(103, { agentId: OTHER_AGENT, token: TOKEN });
  const untagged = entry(104, undefined);
  const { table, signaled, dead } = fakeTable([mine, olderLaunch, otherAgent, untagged]);
  const report = await sweepAgentLaunchTags({
    agentId: AGENT,
    spareToken: () => TOKEN,
    trigger: "stop",
    table,
  });
  expect(report.matched).toBe(1);
  expect(report.killed).toBe(1);
  expect(report.unkilled).toEqual([]);
  // The fake table only dies on SIGKILL, so the survivor of TERM is escalated.
  expect(signaled).toEqual([
    { pid: 102, signal: "SIGTERM" },
    { pid: 102, signal: "SIGKILL" },
  ]);
  expect(dead.has(101)).toBe(false);
  expect(dead.has(104)).toBe(false);
});

test("spareToken protects the current launch while older tokens are collected", async () => {
  const old = entry(201, { agentId: AGENT, token: OTHER_TOKEN });
  const current = entry(202, { agentId: AGENT, token: TOKEN });
  const { table, dead } = fakeTable([old, current]);
  const report = await sweepAgentLaunchTags({
    agentId: AGENT,
    spareToken: () => TOKEN,
    trigger: "launch",
    table,
  });
  expect(report.matched).toBe(1);
  expect(report.killed).toBe(1);
  expect(dead.has(202)).toBe(false);
});

test("spareToken is consulted after the listing, so a token registered mid-scan still wins", async () => {
  const freshToken = crypto.randomUUID();
  const fresh = entry(203, { agentId: AGENT, token: freshToken });
  const { table, dead } = fakeTable([fresh]);
  let registered: string | undefined;
  const report = await sweepAgentLaunchTags({
    agentId: AGENT,
    spareToken: () => registered,
    trigger: "launch",
    table: {
      ...table,
      async list() {
        // A newer launch registers while the process table is being read.
        registered = freshToken;
        return table.list();
      },
    },
  });
  expect(report.matched).toBe(0);
  expect(dead.size).toBe(0);
});

test("a process whose start stamp changed is never signaled", async () => {
  const mine = entry(301, { agentId: AGENT, token: TOKEN });
  const { table, signaled } = fakeTable([mine]);
  const report = await sweepAgentLaunchTags({
    agentId: AGENT,
    trigger: "exit",
    table: {
      ...table,
      async startStamp(pid) {
        return pid === 301 ? "different-stamp" : table.startStamp(pid);
      },
    },
  });
  expect(report.matched).toBe(1);
  expect(report.killed).toBe(0);
  expect(report.unkilled).toEqual([{ pid: 301, reason: "start_time_changed" }]);
  expect(signaled).toEqual([]);
});

test("the sweep's own pid is never a candidate", async () => {
  const mine = entry(401, { agentId: AGENT, token: TOKEN });
  const { table, dead } = fakeTable([mine]);
  const report = await sweepAgentLaunchTags({
    agentId: AGENT,
    trigger: "stop",
    selfPid: 401,
    table,
  });
  expect(report.matched).toBe(0);
  expect(dead.size).toBe(0);
});

test("the first-launch sweep is claimed once per agent per daemon lifetime", () => {
  const agentId = crypto.randomUUID();
  const otherAgentId = crypto.randomUUID();
  expect(claimAgentLaunchTagSweep(agentId)).toBe(true);
  expect(claimAgentLaunchTagSweep(agentId)).toBe(false);
  expect(claimAgentLaunchTagSweep(agentId)).toBe(false);
  expect(claimAgentLaunchTagSweep(otherAgentId)).toBe(true);
});

/** Real-process coverage on the host table. Escape shapes use this test's own Bun binary:
 * Apple platform binaries (`sh`, `sleep`, `perl`) do not expose their environment to `ps eww`
 * on macOS, so a platform-binary orphan is invisible to the sweep there — a documented boundary.
 * Bun is a third-party binary whose env `ps` reads, and `/proc` reads it on Linux too. */
const isPosix = process.platform === "darwin" || process.platform === "linux";
const BUN = process.execPath;
const BUN_SLEEP = "setTimeout(() => {}, 600000)";

function spawnTagged(cmd: string[], env: Record<string, string>) {
  return Bun.spawn({
    cmd,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

(isPosix ? test : test.skip)(
  "real escaped descendants are collected; env-scrubbed processes survive",
  async () => {
    const agentId = crypto.randomUUID();
    const token = crypto.randomUUID();
    const tag = { COFORGE_AGENT_LAUNCH_TAG: agentLaunchTag(agentId, token) };
    const bunSleep = [BUN, "-e", BUN_SLEEP];
    const children = [
      // setsid escapee: perl re-sessions then execs Bun, so the surviving process is env-visible.
      spawnTagged(
        ["perl", "-MPOSIX", "-e", `setsid(); exec $ENV{BUN_PATH}, "-e", $ENV{BUN_CODE}`],
        { ...tag, BUN_PATH: BUN, BUN_CODE: BUN_SLEEP },
      ),
      // Double-forked escapee, same re-exec trick one generation down.
      spawnTagged(
        [
          "perl",
          "-MPOSIX",
          "-e",
          'if (fork) { wait } else { setsid(); if (fork) { exit } exec $ENV{BUN_PATH}, "-e", $ENV{BUN_CODE} }',
        ],
        { ...tag, BUN_PATH: BUN, BUN_CODE: BUN_SLEEP },
      ),
      // Instant-adopted background job: the wrapper exits, the Bun orphan reparents to init.
      spawnTagged(["sh", "-c", `"$1" -e "$2" &`, "sh", BUN, BUN_SLEEP], tag),
      // An earlier launch's stray of the same Agent: a true stop collects it too.
      spawnTagged(bunSleep, {
        COFORGE_AGENT_LAUNCH_TAG: agentLaunchTag(agentId, crypto.randomUUID()),
      }),
      // The documented boundary: env -i scrubs the tag, so this one must survive the sweep.
      spawnTagged(["env", "-i", BUN, "-e", BUN_SLEEP], {}),
    ];
    // Reap exits promptly so a killed direct child never lingers as a zombie the sweep reads alive.
    for (const child of children) void child.exited.catch(() => {});
    // Let the parents exit and the orphans reparent before scanning.
    await Bun.sleep(700);
    const report = await sweepAgentLaunchTags({ agentId, trigger: "test" });
    expect(report.matched).toBe(4);
    expect(report.killed).toBe(4);
    expect(report.unkilled).toEqual([]);
    // The env-scrubbed boundary case is still our direct child and must still be running.
    expect(await alive(children[4]!.pid)).toBe(true);
    for (const child of children.slice(4)) child.kill("SIGKILL");
  },
  20_000,
);

(isPosix ? test : test.skip)(
  "a wake or recycle launch sweeps nothing: the previous launch's background process survives",
  async () => {
    const agentId = crypto.randomUUID();
    const firstToken = crypto.randomUUID();
    const secondToken = crypto.randomUUID();
    const bunSleep = [BUN, "-e", BUN_SLEEP];
    // Launch one leaves a background process behind; launch two (a wake or cold-idle recycle)
    // registers its own token. The launch path claims the startup sweep once — the second
    // claim is false, so no sweep runs and the first launch's process stays alive.
    const stray = spawnTagged(bunSleep, {
      COFORGE_AGENT_LAUNCH_TAG: agentLaunchTag(agentId, firstToken),
    });
    void stray.exited.catch(() => {});
    await Bun.sleep(300);
    expect(claimAgentLaunchTagSweep(agentId)).toBe(true);
    setAgentLaunchTag(agentId, firstToken);
    // Simulate the second launch: new token registered, claim already spent — no sweep call.
    expect(claimAgentLaunchTagSweep(agentId)).toBe(false);
    setAgentLaunchTag(agentId, secondToken);
    expect(await alive(stray.pid)).toBe(true);
    // A true Stop sweeps every token the Agent carries except the spare — here none is live,
    // so both launches' processes would be collected.
    clearAgentLaunchTag(agentId, secondToken);
    const report = await sweepAgentLaunchTags({
      agentId,
      spareToken: () => agentLaunchTagToken(agentId),
      trigger: "stop",
    });
    expect(report.matched).toBe(1);
    expect(report.killed).toBe(1);
    await Bun.sleep(400);
    expect(await alive(stray.pid)).toBe(false);
  },
  20_000,
);

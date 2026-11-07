import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { completionStream, piProvider, piRuntime, writeOpenAiHost } from "./fixtures/pi-host";

const TEST_AGENT_INSTRUCTIONS = "Test Agent instructions.";

// Same budget rationale as pi-agent-adapter.test.ts: an embedded Pi session is in-process work
// with no product bound, sitting on bun:test's 5s default on a busy host.
setDefaultTimeout(30_000);

test("embedded Pi reports hasLiveTurn false at the moment completed arrives", async () => {
  // Task #651: consumers of completed — the idle-nudge gate among them — read hasLiveTurn inside
  // the event, so the session's turn bookkeeping must already show the turn settled (the
  // invariant Kiro documents on #turn), not a microtask later.
  const root = await mkdtemp(join(tmpdir(), "coforge-pi-liveness-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "host-pi-agent");
  await mkdir(workspace);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => completionStream({ role: "assistant", content: "done" }, "stop"),
  });
  await writeOpenAiHost(agentDir, `${server.url}v1`);
  const session = await piProvider().createAgentSession({
    agentWorkspaceDirectory: workspace,
    instructions: TEST_AGENT_INSTRUCTIONS,
    ...piRuntime(agentDir),
  });
  const liveAtCompleted: (boolean | undefined)[] = [];
  session.subscribe((event: AgentRuntimeEvent) => {
    if (event.type === "completed") liveAtCompleted.push(session.hasLiveTurn);
  });
  try {
    await session.sendMessage("hello");
    expect(liveAtCompleted).toEqual([false]);
    expect(session.hasLiveTurn).toBe(false);
  } finally {
    await session.dispose();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("a prompt still in preflight keeps the turn live through the previous settle, and interrupt aborts it", async () => {
  // Task #651 review: clearing every pending prompt at agent_settled also drops a prompt
  // still inside the SDK's preflight (_runInputHandlers/checkAuth), which has no run yet —
  // hasLiveTurn would read idle and interrupt()/dispose() would stop waiting for work that
  // is about to start. Only the settled run's own prompt may be retired.
  const root = await mkdtemp(join(tmpdir(), "coforge-pi-preflight-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "host-pi-agent");
  await mkdir(workspace);
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await Bun.write(
    join(agentDir, "extensions", "input-gate.ts"),
    `export default function (pi) {
      pi.on("input", async () => {
        const gate = globalThis.__piInputGate;
        if (gate) {
          globalThis.__piInputGateHits = (globalThis.__piInputGateHits ?? 0) + 1;
          await gate;
        }
      });
    }`,
  );
  const globals = globalThis as {
    __piInputGate?: Promise<void>;
    __piInputGateHits?: number;
  };
  let releaseFirst!: () => void;
  const firstResponse = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstArrived!: () => void;
  const arrived = new Promise<void>((resolve) => {
    firstArrived = resolve;
  });
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests += 1;
      if (requests === 1) {
        firstArrived();
        return firstResponse.then(() =>
          completionStream({ role: "assistant", content: "one" }, "stop"),
        );
      }
      return completionStream({ role: "assistant", content: "two" }, "stop");
    },
  });
  await writeOpenAiHost(agentDir, `${server.url}v1`);
  const session = await piProvider().createAgentSession({
    agentWorkspaceDirectory: workspace,
    instructions: TEST_AGENT_INSTRUCTIONS,
    ...piRuntime(agentDir),
  });
  const statuses: string[] = [];
  const liveAtCompleted: (boolean | undefined)[] = [];
  session.subscribe((event: AgentRuntimeEvent) => {
    if (event.type === "completed") {
      statuses.push(event.status);
      liveAtCompleted.push(session.hasLiveTurn);
    }
  });
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  try {
    const first = session.sendMessage("first");
    await arrived;
    // Arm the stall, then queue a notice: its prompt() sits inside the extension's input
    // handler — past the deferred-settle check, before any run exists.
    globals.__piInputGate = gate;
    const notifyPromise = session.notify?.("second");
    const notifyDone = notifyPromise
      ? notifyPromise.then(
          () => "resolved",
          () => "rejected",
        )
      : Promise.resolve("unavailable");
    while ((globals.__piInputGateHits ?? 0) === 0) await Bun.sleep(5);
    releaseFirst();
    await first;
    // Turn 1 settled while prompt 2 is still in preflight: the Agent is not idle.
    expect(session.hasLiveTurn).toBe(true);
    expect(liveAtCompleted).toEqual([true]);
    let interruptResolved = false;
    const interruptDone = session.interrupt().then(() => {
      interruptResolved = true;
    });
    await Bun.sleep(50);
    // interrupt() must keep waiting for the gated prompt rather than settle early.
    expect(interruptResolved).toBe(false);
    releaseGate();
    await interruptDone;
    expect(await notifyDone).toBe("resolved");
    await session.dispose();
    // The queued prompt's run was aborted at agent_start instead of running to completion.
    expect(statuses).toEqual(["completed", "interrupted"]);
    expect(session.hasLiveTurn).toBe(false);
  } finally {
    delete globals.__piInputGate;
    await session.dispose();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

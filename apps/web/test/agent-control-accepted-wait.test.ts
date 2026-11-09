import { expect, test } from "bun:test";
import {
  AgentControl,
  type AgentControlAgent,
  type AgentControlStore,
} from "#src/server/agents/agent-control.server";
import { agentControlAcceptedKey } from "#src/server/agents/agent-control-driver.server";
import {
  LocalAgentControlSignal,
  type AgentControlSignal,
} from "#src/server/agents/agent-control-signal.server";
import { decodeAgentStartIntent } from "@lrm/coforge-sdk/internal";

/** The `execute()` wait of task #584: a capable Daemon's `accepted` acknowledgement ends it with
 * the pending view; a Daemon without the capability is answered pending right after publish. */
function executeAcceptedFixture(options: { capability: boolean }, signal?: AgentControlSignal) {
  let agent: AgentControlAgent = {
    id: "agent-a",
    workspaceId: "workspace-a",
    computerId: "computer-a",
    ownerId: "owner-a",
    visibility: "public",
    runtimeConfig: {
      runtime: "pi",
      provider: { kind: "default" },
      model: "",
      modelProvider: "",
      reasoning: "",
    },
    state: null,
  };
  const store: AgentControlStore = {
    memberRole: async () => "owner",
    async get() {
      return structuredClone(agent);
    },
    async replace(before, state) {
      if (JSON.stringify(before.state) !== JSON.stringify(agent.state)) return false;
      agent = { ...agent, state };
      return true;
    },
  };
  const starts: ReturnType<typeof decodeAgentStartIntent>[] = [];
  const control = new AgentControl(
    store,
    {
      async publish(_channel, bytes) {
        starts.push(decodeAgentStartIntent(bytes));
      },
    },
    { run: async (_id, work) => work() },
    { timeoutMs: 60_000, fallbackMs: 60_000 },
    undefined,
    signal,
    undefined,
    undefined,
    undefined,
    undefined,
    { supports: async () => options.capability },
  );
  return { agent: () => agent, starts, control };
}

test("execute() answers the pending view on the Daemon's accepted acknowledgement", async () => {
  const { starts, control } = executeAcceptedFixture({ capability: true });
  const started = Date.now();
  const pending = control.execute({
    userId: "owner-a",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    requestId: "req-accepted",
    action: "start",
  });
  // The acknowledgement is the Daemon's receipt ahead of the serialized launch: milliseconds,
  // not the operation's seconds.
  await Bun.sleep(10);
  const start = starts[0]!;
  await control.accepted(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    {
      ...start,
      provider: start.provider!,
      epoch: start.controlEpoch!,
      phase: "accepted",
      sequence: 1,
    },
  );
  const result = await pending;
  expect(result).toMatchObject({ requestId: "req-accepted", action: "start", phase: "pending" });
  // Well inside the 2s acknowledgement bound: the request-scoped wake ended the wait.
  expect(Date.now() - started).toBeLessThan(1_000);
});

test("execute() answers pending without waiting when the Daemon lacks the capability", async () => {
  const { control } = executeAcceptedFixture({ capability: false });
  const started = Date.now();
  const result = await control.execute({
    userId: "owner-a",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    requestId: "req-old-daemon",
    action: "start",
  });
  expect(result).toMatchObject({ requestId: "req-old-daemon", action: "start", phase: "pending" });
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("execute() still settles on a terminal result that beats the acknowledgement", async () => {
  const { starts, control } = executeAcceptedFixture({ capability: true });
  const done = control.execute({
    userId: "owner-a",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    requestId: "req-terminal-first",
    action: "start",
  });
  await Bun.sleep(10);
  const start = starts[0]!;
  await control.authorizeLaunch({ ...start, controlEpoch: start.controlEpoch! });
  await control.result(start, {
    ...start,
    epoch: start.controlEpoch!,
    launchId: start.launchId!,
    phase: "started",
    sequence: 2,
    identity: { sessionId: "native-a", state: "resumable" },
  });
  const result = await done;
  expect(result.phase).toBe("completed");
});

test("execute() honours an accepted marker an early acknowledgement left behind", async () => {
  const signal = new LocalAgentControlSignal();
  const { control } = executeAcceptedFixture({ capability: true }, signal);
  // The acknowledgement fired while no waiter was registered: its notify was dropped and only
  // the remembered marker remains — the early-ack case raft's review asked about.
  await signal.remember(agentControlAcceptedKey("req-early"));
  const started = Date.now();
  const result = await control.execute({
    userId: "owner-a",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    requestId: "req-early",
    action: "start",
  });
  expect(result).toMatchObject({ requestId: "req-early", action: "start", phase: "pending" });
  expect(Date.now() - started).toBeLessThan(1_000);
});

test("the receiver remembers the request-scoped accepted key before it notifies", async () => {
  const inner = new LocalAgentControlSignal();
  const rememberedKeys: string[] = [];
  const signal: AgentControlSignal = {
    notify: (key) => inner.notify(key),
    wait: (key, ms) => inner.wait(key, ms),
    remember: async (key) => {
      rememberedKeys.push(key);
      await inner.remember(key);
    },
    remembered: (key) => inner.remembered(key),
  };
  const { starts, control } = executeAcceptedFixture({ capability: true }, signal);
  const pending = control.execute({
    userId: "owner-a",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    requestId: "req-wired",
    action: "start",
  });
  await Bun.sleep(10);
  const start = starts[0]!;
  await control.accepted(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    {
      ...start,
      provider: start.provider!,
      epoch: start.controlEpoch!,
      phase: "accepted",
      sequence: 1,
    },
  );
  await pending;
  expect(rememberedKeys).toContain(agentControlAcceptedKey("req-wired"));
});

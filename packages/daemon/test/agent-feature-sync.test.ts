import { expect, test } from "bun:test";
import { AgentFeatureSync } from "#src/daemon-runtime/agent-feature-sync";

type Features = { taskConversations?: boolean; artifacts?: boolean };
type Message = { agentId: string; text: string; features?: Features };

const NOTICE_ON =
  "CoForge notice: this workspace's features changed: Task conversations turned on " +
  "(a task has its own conversation: `coforge task reply`); " +
  "Your standing instructions now describe what is available here. No reply is needed.";
const NOTICE_OFF =
  "CoForge notice: this workspace's features changed: Task conversations turned off for new tasks " +
  "(a task that already has a conversation keeps it); " +
  "Your standing instructions now describe what is available here. No reply is needed.";
const ARTIFACTS_ON =
  "CoForge notice: this workspace's features changed: Documents turned on " +
  "(`coforge artifact` creates and edits them); " +
  "Your standing instructions now describe what is available here. No reply is needed.";

/** A fake runtime: a restart ends the session and relaunches it with `serverFeatures`, then
 * delivers what was kept, the way the wake launch presents waiting deliveries. */
function harness(launchedWith: Features, serverFeatures: Features) {
  const events: string[] = [];
  const kept: Message[] = [];
  const sync: AgentFeatureSync = new AgentFeatureSync({
    live: () => true,
    keep: (message) => kept.push(message as unknown as Message),
    restart: async (agentId) => {
      events.push("restart");
      sync.launched(agentId, { features: serverFeatures });
      for (const message of kept.splice(0))
        events.push(`input:${sync.noticePrefix(agentId)}${message.text}`);
    },
  });
  sync.launched("a", { features: launchedWith });
  const deliver = async (message: Message) => {
    if (sync.changed(message as never)) await sync.restart(message as never);
    else events.push(`input:${sync.noticePrefix(message.agentId)}${message.text}`);
  };
  return { events, deliver };
}

test("a change restarts first, then delivers the input behind one notice", async () => {
  const { events, deliver } = harness({ taskConversations: false }, { taskConversations: true });
  await deliver({ agentId: "a", text: "hi", features: { taskConversations: true } });
  await deliver({ agentId: "a", text: "again", features: { taskConversations: true } });
  expect(events).toEqual(["restart", `input:${NOTICE_ON}\nhi`, "input:again"]);
});

test("turning it off says so", async () => {
  const { events, deliver } = harness({ taskConversations: true }, { taskConversations: false });
  await deliver({ agentId: "a", text: "hi", features: { taskConversations: false } });
  expect(events).toEqual(["restart", `input:${NOTICE_OFF}\nhi`]);
});

test("an artifacts flip restarts the same way and names documents", async () => {
  const { events, deliver } = harness(
    { taskConversations: true, artifacts: false },
    { taskConversations: true, artifacts: true },
  );
  await deliver({
    agentId: "a",
    text: "hi",
    features: { taskConversations: true, artifacts: true },
  });
  expect(events).toEqual(["restart", `input:${ARTIFACTS_ON}\nhi`]);
});

test("two flips in one delivery make one notice naming both", async () => {
  const { events, deliver } = harness(
    { taskConversations: false, artifacts: false },
    { taskConversations: true, artifacts: true },
  );
  await deliver({
    agentId: "a",
    text: "hi",
    features: { taskConversations: true, artifacts: true },
  });
  expect(events).toHaveLength(2);
  expect(events[1]).toContain("Task conversations turned on");
  expect(events[1]).toContain("Documents turned on");
});

test("a delivery that does not name artifacts never restarts over it", async () => {
  // A server that predates the artifacts field states only taskConversations: documents-off at
  // launch must not read as a change, and documents-on must not either.
  for (const launchedArtifacts of [false, true]) {
    const { events, deliver } = harness(
      { taskConversations: true, artifacts: launchedArtifacts },
      { taskConversations: true, artifacts: launchedArtifacts },
    );
    await deliver({ agentId: "a", text: "hi", features: { taskConversations: true } });
    expect(events).toEqual(["input:hi"]);
  }
});

test("the same value restarts nothing", async () => {
  const { events, deliver } = harness(
    { taskConversations: true, artifacts: true },
    { taskConversations: true, artifacts: true },
  );
  await deliver({
    agentId: "a",
    text: "hi",
    features: { taskConversations: true, artifacts: true },
  });
  expect(events).toEqual(["input:hi"]);
});

test("a delivery from an old server, with no features, restarts nothing", async () => {
  const { events, deliver } = harness(
    { taskConversations: true, artifacts: true },
    { taskConversations: true, artifacts: true },
  );
  await deliver({ agentId: "a", text: "hi" });
  expect(events).toEqual(["input:hi"]);
});

test("a session launched with the current value gets no notice", async () => {
  const { events, deliver } = harness({ taskConversations: false }, { taskConversations: true });
  await deliver({ agentId: "a", text: "one", features: { taskConversations: true } });
  await deliver({ agentId: "a", text: "two", features: { taskConversations: true } });
  expect(events.filter((event) => event.includes("CoForge notice"))).toHaveLength(1);
});

test("an Agent that is not live is never restarted by a delivery", async () => {
  const sync = new AgentFeatureSync({ live: () => false, keep: () => {}, restart: async () => {} });
  sync.launched("a", { features: { taskConversations: false, artifacts: false } });
  expect(
    sync.changed({
      agentId: "a",
      features: { taskConversations: true, artifacts: true },
    } as never),
  ).toBe(false);
});

test("a launch config that states no features never restarts the session over a delivery", async () => {
  const restarts: string[] = [];
  const sync = new AgentFeatureSync({
    live: () => true,
    keep: () => {},
    restart: async (agentId) => void restarts.push(agentId),
  });
  sync.launched("a", {});
  expect(
    sync.changed({
      agentId: "a",
      features: { taskConversations: true, artifacts: true },
    } as never),
  ).toBe(false);
  expect(restarts).toEqual([]);
});

test("a restart that fails leaves no notice for a prompt that did not change", async () => {
  const sync = new AgentFeatureSync({
    live: () => true,
    keep: () => {},
    restart: async () => {
      throw new Error("the process would not end");
    },
  });
  sync.launched("a", { features: { taskConversations: false, artifacts: false } });
  await expect(
    sync.restart({
      agentId: "a",
      features: { taskConversations: true, artifacts: true },
    } as never),
  ).rejects.toThrow();
  expect(sync.noticePrefix("a")).toBe("");
});

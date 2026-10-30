import { expect, test } from "bun:test";
import {
  AgentFeatureSync,
  FEATURE_NOTICE_OFF,
  FEATURE_NOTICE_ON,
} from "#src/daemon-runtime/agent-feature-sync";

type Message = { agentId: string; text: string; features?: { taskConversations?: boolean } };

/** A fake runtime: a restart ends the session and relaunches it with `serverValue`, then delivers
 * what was kept, the way the wake launch presents waiting deliveries. */
function harness(launchedWith: boolean, serverValue: boolean) {
  const events: string[] = [];
  const kept: Message[] = [];
  const sync: AgentFeatureSync = new AgentFeatureSync({
    live: () => true,
    keep: (message) => kept.push(message as unknown as Message),
    restart: async (agentId) => {
      events.push("restart");
      sync.launched(agentId, { features: { taskConversations: serverValue } });
      for (const message of kept.splice(0))
        events.push(`input:${sync.noticePrefix(agentId)}${message.text}`);
    },
  });
  sync.launched("a", { features: { taskConversations: launchedWith } });
  const deliver = async (message: Message) => {
    if (!(await sync.restartIfChanged(message as never)))
      events.push(`input:${sync.noticePrefix(message.agentId)}${message.text}`);
  };
  return { events, deliver };
}

test("a change restarts first, then delivers the input behind one notice", async () => {
  const { events, deliver } = harness(false, true);
  await deliver({ agentId: "a", text: "hi", features: { taskConversations: true } });
  await deliver({ agentId: "a", text: "again", features: { taskConversations: true } });
  expect(events).toEqual(["restart", `input:${FEATURE_NOTICE_ON}\nhi`, "input:again"]);
});

test("turning it off says so", async () => {
  const { events, deliver } = harness(true, false);
  await deliver({ agentId: "a", text: "hi", features: { taskConversations: false } });
  expect(events).toEqual(["restart", `input:${FEATURE_NOTICE_OFF}\nhi`]);
});

test("the same value restarts nothing", async () => {
  const { events, deliver } = harness(true, true);
  await deliver({ agentId: "a", text: "hi", features: { taskConversations: true } });
  expect(events).toEqual(["input:hi"]);
});

test("a delivery from an old server, with no features, restarts nothing", async () => {
  const { events, deliver } = harness(true, true);
  await deliver({ agentId: "a", text: "hi" });
  expect(events).toEqual(["input:hi"]);
});

test("a session launched with the current value gets no notice", async () => {
  const { events, deliver } = harness(false, true);
  await deliver({ agentId: "a", text: "one", features: { taskConversations: true } });
  await deliver({ agentId: "a", text: "two", features: { taskConversations: true } });
  expect(events.filter((event) => event.includes("CoForge notice"))).toHaveLength(1);
});

test("an Agent that is not live is never restarted by a delivery", async () => {
  const sync = new AgentFeatureSync({ live: () => false, keep: () => {}, restart: async () => {} });
  sync.launched("a", { features: { taskConversations: false } });
  expect(
    await sync.restartIfChanged({ agentId: "a", features: { taskConversations: true } } as never),
  ).toBe(false);
});

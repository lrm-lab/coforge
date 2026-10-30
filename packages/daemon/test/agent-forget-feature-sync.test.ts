import { expect, test } from "bun:test";
import { AgentFeatureSync } from "#src/daemon-runtime/agent-feature-sync";
import { forgetLocalAgent } from "#src/daemon-runtime/agent-forget";

test("forgetting an Agent leaves nothing of its feature state: no launched value, no owed notice", async () => {
  const sync = new AgentFeatureSync({ live: () => true, keep: () => {}, restart: async () => {} });
  sync.launched("a", { features: { taskConversations: false } });
  await sync.restart({ agentId: "a", features: { taskConversations: true } } as never);
  forgetLocalAgent("a", {
    systemCleaner: { replaceOwnerSnapshot() {} },
    offlineResidency: { forget() {} },
    agentInboxes: new Map(),
    messageAttention: { clearAgent() {} },
    consumedSeqs: { remove() {} },
    appInboxes: new Map(),
    featureSync: sync,
  } as never);
  expect(sync.noticePrefix("a")).toBe("");
  expect(sync.changed({ agentId: "a", features: { taskConversations: true } } as never)).toBe(
    false,
  );
});

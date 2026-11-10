import { expect, test } from "bun:test";

import {
  agentDeliveryBlockers,
  type AgentDeliveryAudience,
} from "#src/server/conversations/agent-delivery-reasons.server";

const audience = (...ids: string[]): AgentDeliveryAudience => new Set(ids);

test("reports a muted top-level Agent only when it is outside the real audience", () => {
  expect(
    agentDeliveryBlockers({
      message: { threadRootId: null, hasAgentMention: false },
      agents: [
        { agentId: "muted", notificationLevel: "muted" },
        { agentId: "loud", notificationLevel: "all" },
      ],
      audience: audience("loud"),
      seenAgentIds: [],
      hasActiveCoordinator: false,
      unfollowed: [],
    }),
  ).toEqual([{ id: "muted", reason: "channel_muted" }]);
});

test("does not call coordinator or mention exclusion a mute", () => {
  const common = {
    agents: [{ agentId: "agent", notificationLevel: "muted" }],
    seenAgentIds: [],
    unfollowed: [],
  } as const;
  expect(
    agentDeliveryBlockers({
      ...common,
      message: { threadRootId: null, hasAgentMention: false },
      audience: audience("agent"),
      hasActiveCoordinator: true,
    }),
  ).toEqual([]);
  expect(
    agentDeliveryBlockers({
      ...common,
      message: { threadRootId: null, hasAgentMention: true },
      audience: audience(),
      hasActiveCoordinator: false,
    }),
  ).toEqual([]);
});

test("reports only a recorded thread unfollow, not an Agent that never followed", () => {
  expect(
    agentDeliveryBlockers({
      message: { threadRootId: "root", hasAgentMention: false },
      agents: [
        { agentId: "unfollowed", notificationLevel: "all" },
        { agentId: "never-followed", notificationLevel: "all" },
      ],
      audience: audience(),
      seenAgentIds: [],
      hasActiveCoordinator: false,
      unfollowed: [{ agentId: "unfollowed", rootMessageId: "root" }],
    }),
  ).toEqual([{ id: "unfollowed", reason: "thread_unfollowed" }]);
});

test("a refollowed Agent is back in the real audience, even after a prior unfollow", () => {
  expect(
    agentDeliveryBlockers({
      message: { threadRootId: "root", hasAgentMention: false },
      agents: [{ agentId: "renamed-agent", notificationLevel: "all" }],
      audience: audience("renamed-agent"),
      seenAgentIds: [],
      hasActiveCoordinator: false,
      unfollowed: [{ agentId: "renamed-agent", rootMessageId: "root" }],
    }),
  ).toEqual([]);
});

test("seen blockers are omitted, and an Agent mention still follows the real audience", () => {
  expect(
    agentDeliveryBlockers({
      message: { threadRootId: "root", hasAgentMention: true },
      agents: [{ agentId: "unfollowed", notificationLevel: "muted" }],
      audience: audience("unfollowed"),
      seenAgentIds: ["unfollowed"],
      hasActiveCoordinator: false,
      unfollowed: [{ agentId: "unfollowed", rootMessageId: "root" }],
    }),
  ).toEqual([]);
});

import { expect, test } from "bun:test";
import {
  decodeAgentActivity,
  encodeAgentActivity,
  type AgentActivity,
} from "@lrm/coforge-sdk/internal";

import { handleAgentActivityPublication } from "#src/server/agents/agent-activity-publish.server";
import { PUBLICATION_REROUTED_CODE } from "#src/server/agents/agent-activity-relay.server";

/**
 * Task #302: an Agent's Activity in a private channel goes live only to the channel's people, each
 * on their own channel, and the status everyone who sees the Agent shows keeps its kind but not
 * its words. What decides the people is `privateActivityAudience` (private-channel-surfaces).
 */
const activity = {
  protocolMajor: 1,
  requestId: "activity-1",
  workspaceId: "workspace-1",
  agentId: "agent-1",
  detailKind: "model_response_started",
  level: "info",
  detail: "Drafting the launch plan",
  entries: [{ kind: "text" as const, text: "the secret launch date" }],
  conversationId: "channel-1",
  conversationTarget: "#launch",
  observedAtMs: Date.parse("2026-10-31T00:00:00.000Z"),
  launchId: "launch-1",
  clientSeq: 1,
} satisfies AgentActivity;

const request = () => {
  let binary = "";
  for (const byte of encodeAgentActivity(activity)) binary += String.fromCharCode(byte);
  return new Request("http://backend/api/internal/centrifugo-agent-activity", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-coforge-centrifugo-proxy-secret": "test-secret",
    },
    body: JSON.stringify({
      user: "user-1",
      channel: "agent:activity:workspace-1",
      b64data: btoa(binary),
      meta: { workspace_id: "workspace-1", computer_id: "computer-1" },
    }),
  });
};

async function publishWith(audience: readonly string[] | undefined) {
  const toPeople: { userIds: readonly string[]; frame: Uint8Array }[] = [];
  const displayed: Record<string, unknown>[] = [];
  const history: unknown[] = [];
  const response = await handleAgentActivityPublication(request(), {
    proxySecret: "test-secret",
    agentVisibility: async () => "public",
    agentBelongsToWorkspace: async () => true,
    agentBelongsToComputer: async () => true,
    computerBelongsToWorkspace: async () => true,
    observe: async (value) => {
      history.push(value);
    },
    currentRuntimeFence: async () => ({ daemonInstanceId: "daemon-1", launchId: "launch-1" }),
    display: {
      observeActivity: async (value) => {
        displayed.push(value);
        return undefined;
      },
    },
    privateAudience: async (scope) => {
      expect(scope).toEqual({
        workspaceId: "workspace-1",
        agentId: "agent-1",
        conversationId: "channel-1",
      });
      return audience;
    },
    publishToPeople: async (userIds, frame) => {
      toPeople.push({ userIds, frame });
    },
  });
  return {
    body: (await response.json()) as {
      result?: { b64data: string };
      error?: { code: number };
    },
    toPeople,
    displayed,
    history,
  };
}

test("a private channel's Activity goes to its people alone, whole", async () => {
  const { body, toPeople, history } = await publishWith(["user-2", "user-3"]);
  // Not answered with the frame, so the Workspace's shared channel never carries it.
  expect(body.result).toBeUndefined();
  expect(body.error?.code).toBe(PUBLICATION_REROUTED_CODE);
  expect(toPeople.map((sent) => sent.userIds)).toEqual([["user-2", "user-3"]]);
  expect(decodeAgentActivity(toPeople[0]!.frame)).toMatchObject({
    detail: activity.detail,
    entries: activity.entries,
    conversationTarget: "#launch",
  });
  // History keeps everything; the feed filters it per viewer.
  expect(history).toEqual([expect.objectContaining({ detail: activity.detail })]);
});

test("the Agent's status keeps the kind of a private channel's Activity, not its words", async () => {
  const { displayed } = await publishWith(["user-2"]);
  expect(displayed).toHaveLength(1);
  expect(displayed[0]).toMatchObject({ detailKind: activity.detailKind, detail: "" });
  for (const key of ["entries", "conversationId", "conversationTarget"])
    expect(displayed[0]).not.toHaveProperty(key);
});

test("a private channel with none of its people who see the Agent sends nothing live", async () => {
  const { body, toPeople } = await publishWith([]);
  expect(body.result).toBeUndefined();
  expect(toPeople).toEqual([]);
});

test("any other conversation's Activity goes out as before, words and all", async () => {
  const { body, toPeople, displayed } = await publishWith(undefined);
  expect(toPeople).toEqual([]);
  const shared = decodeAgentActivity(
    Uint8Array.from(atob(body.result!.b64data), (character) => character.charCodeAt(0)),
  );
  expect(shared).toMatchObject({ detail: activity.detail, conversationTarget: "#launch" });
  expect(displayed[0]).toMatchObject({ detail: activity.detail, entries: activity.entries });
});

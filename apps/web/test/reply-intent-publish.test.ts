import { describe, expect, test } from "bun:test";
import {
  decodeAgentActivityFrame,
  encodeAgentReplyIntent,
  REPLY_INTENT_PHASE,
  type AgentReplyIntent,
} from "@lrm/coforge-sdk/internal/reply-intent";

import { handleAgentActivityPublication } from "#src/server/agents/agent-activity-publish.server";
import type { ReplyIntentTarget } from "#src/server/agents/reply-intent-publish.server";

const frame = (intent: AgentReplyIntent["intent"], overrides: Partial<AgentReplyIntent> = {}) =>
  ({
    protocolMajor: 1,
    requestId: "request-1",
    workspaceId: "workspace-1",
    agentId: "agent-1",
    observedAtMs: Date.parse("2026-10-24T00:00:00.000Z"),
    intent,
    ...overrides,
  }) satisfies AgentReplyIntent;

const base64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const fromBase64 = (value: string) =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

const startFrame = frame({ phase: REPLY_INTENT_PHASE.START, callId: "call-1", target: "#general" });
const endFrame = frame({ phase: REPLY_INTENT_PHASE.END, callId: "call-1", target: "#general" });
const directStart = frame({ phase: REPLY_INTENT_PHASE.START, callId: "call-1", target: "@frank" });
const directEnd = frame({ phase: REPLY_INTENT_PHASE.END, callId: "call-1", target: "@frank" });

const request = (value: AgentReplyIntent) =>
  new Request("http://backend/api/internal/centrifugo-agent-activity", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-coforge-centrifugo-proxy-secret": "test-secret",
    },
    body: JSON.stringify({
      user: "user-1",
      channel: "agent:activity:workspace-1",
      b64data: base64(encodeAgentReplyIntent(value)),
      meta: { workspace_id: "workspace-1", computer_id: "computer-1" },
    }),
  });

type Published = { channel: string; data: Uint8Array; skipHistory?: boolean };

function dependencies(overrides: Record<string, unknown> = {}) {
  const observed: unknown[] = [];
  const displayed: unknown[] = [];
  const published: Published[] = [];
  const resolved: string[] = [];
  return {
    observed,
    displayed,
    published,
    resolved,
    deps: {
      proxySecret: "test-secret",
      agentVisibility: async () => "public",
      agentBelongsToWorkspace: async () => true,
      agentBelongsToComputer: async () => true,
      computerBelongsToWorkspace: async () => true,
      observe: async (value: unknown) => {
        observed.push(value);
      },
      currentRuntimeFence: async () => ({ daemonInstanceId: "daemon-1", launchId: "launch-1" }),
      display: {
        observeActivity: async (value: unknown) => {
          displayed.push(value);
          return undefined;
        },
      },
      publish: async (channel: string, data: Uint8Array, options?: { skipHistory?: boolean }) => {
        published.push({ channel, data, ...options });
      },
      resolveReplyTarget: async ({ target }: { target: string }): Promise<ReplyIntentTarget> => {
        resolved.push(target);
        return target.startsWith("@")
          ? { conversationId: "dm-1", threadRootId: null, peerUserId: "user-frank" }
          : { conversationId: "conversation-1", threadRootId: "root-1" };
      },
      ...overrides,
    } as Parameters<typeof handleAgentActivityPublication>[1],
  };
}

function replyIntentOf(bytes: Uint8Array): AgentReplyIntent {
  const decoded = decodeAgentActivityFrame(bytes);
  if (!("replyIntent" in decoded)) throw new Error("not a reply intent");
  return decoded.replyIntent;
}

async function relayed(response: Response) {
  const body = (await response.json()) as { result?: { skip_history: boolean; b64data: string } };
  return body.result && replyIntentOf(fromBase64(body.result.b64data));
}
const errorCode = async (response: Response) =>
  ((await response.json()) as { error: { code: number } }).error.code;

describe("reply intent publication to a channel", () => {
  test("a public Agent's start is relayed with the resolved conversation and thread, never the raw target", async () => {
    const { deps, observed, displayed, resolved } = dependencies();
    const response = await handleAgentActivityPublication(request(startFrame), deps);
    const body = (await response.clone().json()) as { result: { skip_history: boolean } };
    expect(body.result.skip_history).toBe(true);
    expect(resolved).toEqual(["#general"]);
    expect(await relayed(response)).toEqual(
      frame({
        phase: REPLY_INTENT_PHASE.START,
        callId: "call-1",
        conversationId: "conversation-1",
        threadRootId: "root-1",
      }),
    );
    // It is a signal, not an observation: nothing stored, no display change.
    expect(observed).toEqual([]);
    expect(displayed).toEqual([]);
  });

  test("a top-level target is relayed without a thread root, and the early flag survives", async () => {
    const { deps } = dependencies({
      resolveReplyTarget: async () => ({ conversationId: "conversation-1", threadRootId: null }),
    });
    const early = frame({ ...startFrame.intent, early: true });
    expect(
      (await relayed(await handleAgentActivityPublication(request(early), deps)))?.intent,
    ).toEqual({ phase: "start", callId: "call-1", early: true, conversationId: "conversation-1" });
  });

  test("an end is relayed as the call id and phase alone, resolving nothing", async () => {
    const { deps, resolved } = dependencies();
    const response = await handleAgentActivityPublication(request(endFrame), deps);
    expect(await relayed(response)).toEqual(
      frame({ phase: REPLY_INTENT_PHASE.END, callId: "call-1" }),
    );
    expect(resolved).toEqual([]);
  });

  test("a private Agent's start goes to its own channel and is denied on the shared one", async () => {
    const { deps, published } = dependencies({ agentVisibility: async () => "private" });
    const response = await handleAgentActivityPublication(request(startFrame), deps);
    expect(await errorCode(response)).toBe(1000);
    expect(published).toHaveLength(1);
    expect(published[0]!.channel).toBe("agent:activity:workspace-1:agent-1");
    expect(replyIntentOf(published[0]!.data).intent).toMatchObject({
      conversationId: "conversation-1",
      threadRootId: "root-1",
    });
  });

  test("a private Agent's end goes to its own channel too, stripped", async () => {
    const { deps, published } = dependencies({ agentVisibility: async () => "private" });
    await handleAgentActivityPublication(request(endFrame), deps);
    expect(published.map((item) => item.channel)).toEqual(["agent:activity:workspace-1:agent-1"]);
    expect(replyIntentOf(published[0]!.data).intent).toEqual({ phase: "end", callId: "call-1" });
  });
});

describe("reply intent publication to a direct message", () => {
  for (const visibility of ["public", "private"])
    test(`a ${visibility} Agent's start reaches only the person's own channel, never an Activity channel`, async () => {
      const { deps, published } = dependencies({ agentVisibility: async () => visibility });
      const response = await handleAgentActivityPublication(request(directStart), deps);
      // The daemon's own publication is dropped: nothing for the shared channel.
      expect(await errorCode(response)).toBe(1000);
      expect(published.map((item) => item.channel)).toEqual(["chat:user:user-frank"]);
      expect(published[0]!.skipHistory).toBe(true);
      expect(replyIntentOf(published[0]!.data)).toEqual(
        frame({ phase: "start", callId: "call-1", conversationId: "dm-1" }),
      );
    });

  test("a thread in the direct message keeps its root", async () => {
    const { deps, published } = dependencies({
      resolveReplyTarget: async () => ({
        conversationId: "dm-1",
        threadRootId: "root-9",
        peerUserId: "user-frank",
      }),
    });
    await handleAgentActivityPublication(request(directStart), deps);
    expect(replyIntentOf(published[0]!.data).intent.threadRootId).toBe("root-9");
  });

  test("its end goes the same way, resolved again and stripped to the call id", async () => {
    const { deps, published, resolved } = dependencies();
    const response = await handleAgentActivityPublication(request(directEnd), deps);
    expect(await errorCode(response)).toBe(1000);
    expect(resolved).toEqual(["@frank"]);
    expect(published.map((item) => item.channel)).toEqual(["chat:user:user-frank"]);
    expect(replyIntentOf(published[0]!.data).intent).toEqual({ phase: "end", callId: "call-1" });
  });

  test("a target that names no person's direct message publishes nothing anywhere", async () => {
    for (const resolveReplyTarget of [
      async () => undefined,
      // A resolution that names a conversation but no person is never put on a shared channel.
      async () => ({ conversationId: "dm-1", threadRootId: null }),
      async () => {
        throw new Error("database unavailable");
      },
    ]) {
      const { deps, published } = dependencies({ resolveReplyTarget });
      const response = await handleAgentActivityPublication(request(directStart), deps);
      expect(await errorCode(response)).toBe(403);
      expect(published).toEqual([]);
    }
  });
});

describe("reply intent publication scope", () => {
  test("a target that resolves to nothing publishes nothing", async () => {
    const { deps, published } = dependencies({
      resolveReplyTarget: async () => undefined,
      agentVisibility: async () => "private",
    });
    const response = await handleAgentActivityPublication(request(startFrame), deps);
    expect(await errorCode(response)).toBe(403);
    expect(published).toEqual([]);
  });

  test("a failing resolution is a denied publication, not a failure", async () => {
    const { deps } = dependencies({
      resolveReplyTarget: async () => {
        throw new Error("database unavailable");
      },
    });
    const response = await handleAgentActivityPublication(request(startFrame), deps);
    expect(await errorCode(response)).toBe(403);
  });

  test("a server with no resolver relays nothing, and a frame with no target is denied", async () => {
    const { deps } = dependencies({ resolveReplyTarget: undefined });
    expect(await errorCode(await handleAgentActivityPublication(request(startFrame), deps))).toBe(
      403,
    );
    const { deps: withResolver } = dependencies();
    const noTarget = frame({ phase: REPLY_INTENT_PHASE.END, callId: "call-1" });
    expect(
      await errorCode(await handleAgentActivityPublication(request(noTarget), withResolver)),
    ).toBe(403);
  });

  test.each([
    ["an Agent of another Computer", { agentBelongsToComputer: async () => false }],
    ["an Agent outside the Workspace", { agentBelongsToWorkspace: async () => false }],
    ["a Computer outside the Workspace", { computerBelongsToWorkspace: async () => false }],
    ["a wrong proxy secret", { proxySecret: "other" }],
  ])("%s is denied", async (_name, overrides) => {
    const { deps, resolved } = dependencies(overrides);
    const response = await handleAgentActivityPublication(request(startFrame), deps);
    expect(await errorCode(response)).toBe(403);
    expect(resolved).toEqual([]);
  });

  test("a frame naming another Workspace than the connection's is denied", async () => {
    const { deps } = dependencies();
    const response = await handleAgentActivityPublication(
      request(frame(startFrame.intent, { workspaceId: "workspace-2" })),
      deps,
    );
    expect(await errorCode(response)).toBe(403);
  });
});

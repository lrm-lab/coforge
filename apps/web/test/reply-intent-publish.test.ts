import { describe, expect, spyOn, test } from "bun:test";
import { cachedReplyTargetResolver } from "#src/server/agents/reply-target-cache.server";
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

const errorCode = async (response: Response) =>
  ((await response.json()) as { error: { code: number } }).error.code;

describe("reply intent publication to a channel", () => {
  for (const visibility of ["public", "private"]) {
    test(`a ${visibility} Agent's start reaches only its conversation without history`, async () => {
      const { deps, observed, displayed, resolved, published } = dependencies({
        agentVisibility: async () => visibility,
      });
      const response = await handleAgentActivityPublication(request(startFrame), deps);
      expect(await errorCode(response)).toBe(1000);
      expect(published.map((item) => item.channel)).toEqual(["chat:conversation-1"]);
      expect(published[0]!.skipHistory).toBe(true);
      expect(replyIntentOf(published[0]!.data)).toEqual(
        frame({
          phase: "start",
          callId: "call-1",
          conversationId: "conversation-1",
          threadRootId: "root-1",
        }),
      );
      expect(resolved).toEqual(["#general"]);
      expect(observed).toEqual([]);
      expect(displayed).toEqual([]);
    });
    test(`a ${visibility} Agent's end resolves the same conversation and carries only call/phase`, async () => {
      const { deps, resolved, published } = dependencies({
        agentVisibility: async () => visibility,
      });
      expect(await errorCode(await handleAgentActivityPublication(request(endFrame), deps))).toBe(
        1000,
      );
      expect(published.map((item) => item.channel)).toEqual(["chat:conversation-1"]);
      expect(published[0]!.skipHistory).toBe(true);
      expect(replyIntentOf(published[0]!.data)).toEqual(frame({ phase: "end", callId: "call-1" }));
      expect(resolved).toEqual(["#general"]);
    });
  }
  test("a top-level target keeps the early flag without a thread root", async () => {
    const { deps, published } = dependencies({
      resolveReplyTarget: async () => ({ conversationId: "conversation-1", threadRootId: null }),
    });
    await handleAgentActivityPublication(
      request(frame({ ...startFrame.intent, early: true })),
      deps,
    );
    expect(published).toHaveLength(1);
    expect(replyIntentOf(published[0]!.data).intent).toEqual({
      phase: "start",
      callId: "call-1",
      early: true,
      conversationId: "conversation-1",
    });
  });
  test("a long turn's repeated starts keep its end on the resolved conversation", async () => {
    let now = 0;
    let reads = 0;
    const resolveReplyTarget = cachedReplyTargetResolver(
      async () => {
        if (++reads !== 1) return undefined;
        return { conversationId: "conversation-1", threadRootId: null };
      },
      { now: () => now },
    );
    const { deps, published } = dependencies({ resolveReplyTarget });
    for (let repeat = 0; repeat < 9; repeat++) {
      now = repeat * 8_000;
      await handleAgentActivityPublication(request(startFrame), deps);
    }
    now += 8_000;
    await handleAgentActivityPublication(request(endFrame), deps);
    expect(reads).toBe(1);
    expect(published).toHaveLength(10);
    expect(new Set(published.map((item) => item.channel))).toEqual(
      new Set(["chat:conversation-1"]),
    );
    expect(replyIntentOf(published.at(-1)!.data).intent).toEqual({
      phase: "end",
      callId: "call-1",
    });
  });
  test.each([endFrame, frame({ phase: "end", callId: "call-1" })])(
    "an unresolved end is dropped and debugged without its target: %j",
    async (end) => {
      const debug = spyOn(console, "debug").mockImplementation(() => {});
      try {
        const { deps, published } = dependencies({ resolveReplyTarget: async () => undefined });
        expect(await errorCode(await handleAgentActivityPublication(request(end), deps))).toBe(403);
        expect(published).toEqual([]);
        expect(debug.mock.calls).toHaveLength(1);
        expect(JSON.parse(String(debug.mock.calls[0]![0]))).toMatchObject({
          event: "reply_intent:end_unresolved",
          workspace_id: "workspace-1",
          agent_id: "agent-1",
          call_id: "call-1",
        });
        expect(JSON.stringify(debug.mock.calls)).not.toContain("#general");
      } finally {
        debug.mockRestore();
      }
    },
  );
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

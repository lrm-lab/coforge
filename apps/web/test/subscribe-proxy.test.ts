import { expect, spyOn, test } from "bun:test";
import {
  answerSubscriptionProxy,
  browserSubscriptionAccess,
  mayHoldChannel,
  SUBSCRIPTION_LIFETIME_S,
  type BrowserSubscriptionAccess,
} from "#src/server/centrifugo/subscribe-proxy.server";
import { BROWSER_PAGE_META } from "#src/server/auth/browser-realtime-token.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  agentActivityChannel,
  agentActivityChannelForAgent,
} from "#src/features/agents/agent-activity";
import {
  agentStatusChannel,
  agentStatusChannelForAgent,
} from "#src/features/agents/agent-status-realtime";
import { runtimeAuthChannel } from "#src/features/computers/runtime-auth-realtime";
import {
  conversationRealtimeChannel,
  userConversationChannel,
  workspaceConversationChannel,
} from "#src/features/conversations/conversation-realtime";
import { workspacePresenceChannel } from "#src/features/workspaces/presence-channel";

const ws = "11111111-1111-4111-8111-111111111111";
const otherWs = "22222222-2222-4222-8222-222222222222";
const ada = "33333333-3333-4333-8333-333333333333";
const grace = "44444444-4444-4444-8444-444444444444";
const conversation = "55555555-5555-4555-8555-555555555555";
const privateAgent = "66666666-6666-4666-8666-666666666666";

/** Ada is a member of `ws`, Grace its admin; Ada reads `conversation`; the private Agent is
 * Grace's. */
const access: BrowserSubscriptionAccess = {
  workspaceRole: async (workspaceId, userId) =>
    workspaceId !== ws
      ? undefined
      : userId === ada
        ? "member"
        : userId === grace
          ? "admin"
          : undefined,
  readsConversation: async (conversationId, userId) =>
    conversationId === conversation && userId === ada,
  workspaceAgent: async (workspaceId, agentId) =>
    workspaceId === ws && agentId === privateAgent
      ? { visibility: "private", ownerId: grace, systemKind: null }
      : undefined,
};

// Built by the channel builders the page subscribes with, so a renamed channel fails here.
test("each channel is held by the people its token used to be issued to", async () => {
  const cases: [string, string, boolean][] = [
    [ada, workspaceConversationChannel(ws), true],
    [ada, workspaceConversationChannel(otherWs), false],
    [ada, agentStatusChannel(ws), true],
    [ada, agentActivityChannel(ws), true],
    [ada, workspacePresenceChannel(ws), true],
    [ada, userConversationChannel(ada), true],
    [ada, userConversationChannel(grace), false],
    [ada, runtimeAuthChannel(ada), true],
    [ada, runtimeAuthChannel(grace), false],
    [ada, conversationRealtimeChannel(conversation), true],
    [grace, conversationRealtimeChannel(conversation), false],
    // A private Agent: its creator and an admin see it, an ordinary member does not.
    [grace, agentStatusChannelForAgent(ws, privateAgent), true],
    [grace, agentActivityChannelForAgent(ws, privateAgent), true],
    [ada, agentStatusChannelForAgent(ws, privateAgent), false],
    [grace, agentStatusChannelForAgent(otherWs, privateAgent), false],
    // Nothing else, and nothing without a user.
    [ada, `daemon:${ws}:${ada}`, false],
    [ada, `chat:workspace:${ws}:extra`, false],
    [ada, "chat:not-a-uuid", false],
    ["", workspaceConversationChannel(ws), false],
  ];
  for (const [user, channel, allowed] of cases)
    expect({ user, channel, allowed: await mayHoldChannel(access, user, channel) }).toEqual({
      user,
      channel,
      allowed,
    });
});

/** A proxy request from a page's connection, whose meta its connection token set. */
const proxyRequest = (body: Record<string, unknown> | string) =>
  new Request("http://web/api/internal/centrifugo-subscribe", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify({ meta: BROWSER_PAGE_META, ...body }),
  });
const now = () => 1_000_000_000_000;

test("a grant carries its expiry; a refusal is final for a subscribe and expires a refresh", async () => {
  const granted = await answerSubscriptionProxy(
    proxyRequest({ user: ada, channel: `chat:user:${ada}` }),
    access,
    { refresh: false, now },
  );
  expect(granted.status).toBe(200);
  expect(await granted.json()).toEqual({
    result: { expire_at: 1_000_000_000 + SUBSCRIPTION_LIFETIME_S },
  });

  const refused = await answerSubscriptionProxy(
    proxyRequest({ user: ada, channel: `chat:user:${grace}` }),
    access,
    { refresh: false, now },
  );
  expect(refused.status).toBe(200);
  expect(await refused.json()).toEqual({ error: { code: 403, message: "permission denied" } });

  const expired = await answerSubscriptionProxy(
    proxyRequest({ user: grace, channel: `chat:${conversation}` }),
    access,
    { refresh: true, now },
  );
  expect(await expired.json()).toEqual({ result: { expired: true } });

  // A malformed request is refused like any other.
  const malformed = await answerSubscriptionProxy(proxyRequest("{"), access, { refresh: false });
  expect(await malformed.json()).toEqual({ error: { code: 403, message: "permission denied" } });
});

test("only a page's connection is answered: a daemon's, or one with no meta, is refused", async () => {
  for (const meta of [{ workspace_id: ws, computer_id: "computer" }, undefined]) {
    const response = await answerSubscriptionProxy(
      proxyRequest({ user: ada, channel: userConversationChannel(ada), meta }),
      access,
      { refresh: false },
    );
    expect(await response.json()).toEqual({ error: { code: 403, message: "permission denied" } });
  }
});

test("a check that cannot answer is a temporary failure the page retries, never a refusal", async () => {
  const logged: unknown[] = [];
  const record = (line: unknown) => {
    logged.push(JSON.parse(String(line)));
  };
  const warn = spyOn(console, "warn").mockImplementation(record);
  const info = spyOn(console, "info").mockImplementation(record);
  try {
    const down: BrowserSubscriptionAccess = {
      ...access,
      workspaceRole: async () => {
        throw new Error("database unavailable");
      },
    };
    for (const refresh of [false, true]) {
      const response = await answerSubscriptionProxy(
        proxyRequest({ user: ada, channel: workspaceConversationChannel(ws) }),
        down,
        { refresh },
      );
      expect(response.status).toBe(503);
    }
    expect(warn).toHaveBeenCalledTimes(2);
    // Every answer is logged with its outcome, for reading a deployment's proxies.
    await answerSubscriptionProxy(
      proxyRequest({ user: ada, channel: workspaceConversationChannel(ws) }),
      access,
      { refresh: true },
    );
    await answerSubscriptionProxy(
      proxyRequest({ user: grace, channel: runtimeAuthChannel(ada) }),
      access,
      { refresh: false },
    );
    const duration_ms = expect.any(Number);
    expect(logged).toEqual([
      {
        event: "centrifugo_proxy:subscribe",
        outcome: "temporary",
        channel_namespace: "chat",
        duration_ms,
        error_type: "Error",
      },
      {
        event: "centrifugo_proxy:sub_refresh",
        outcome: "temporary",
        channel_namespace: "chat",
        duration_ms,
        error_type: "Error",
      },
      {
        event: "centrifugo_proxy:sub_refresh",
        outcome: "allow",
        channel_namespace: "chat",
        duration_ms,
      },
      {
        event: "centrifugo_proxy:subscribe",
        outcome: "deny",
        channel_namespace: "runtimeauth",
        duration_ms,
      },
    ]);
  } finally {
    warn.mockRestore();
    info.mockRestore();
  }
});

test("a page's checks arriving together read a role once, for a few seconds; a failed read or a missing member is not kept", async () => {
  let clock = 0;
  let reads = 0;
  let failNext = false;
  const db = {
    workspaceMembership: {
      findUnique: async ({ where }: { where: { workspaceId_userId: { userId: string } } }) => {
        reads++;
        if (failNext) {
          failNext = false;
          throw new Error("down");
        }
        return where.workspaceId_userId.userId === stranger ? null : { role: "member" };
      },
    },
  } as unknown as PrismaClient;
  const stranger = "77777777-7777-4777-8777-777777777777";
  const cached = browserSubscriptionAccess(db, () => clock);
  await Promise.all([
    cached.workspaceRole(ws, ada),
    cached.workspaceRole(ws, ada),
    cached.workspaceRole(ws, ada),
  ]);
  expect(reads).toBe(1);
  await cached.workspaceRole(ws, grace);
  expect(reads).toBe(2);
  clock = 5_000;
  failNext = true;
  await expect(cached.workspaceRole(ws, ada)).rejects.toThrow("down");
  expect(await cached.workspaceRole(ws, ada)).toBe("member");
  expect(reads).toBe(4);
  expect(await cached.workspaceRole(ws, stranger)).toBeUndefined();
  expect(await cached.workspaceRole(ws, stranger)).toBeUndefined();
  expect(reads).toBe(6);
});

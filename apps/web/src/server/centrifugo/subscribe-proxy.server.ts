import { isRecord } from "@lrm/coforge-sdk/internal";
import { UUID_LIKE_SOURCE } from "@lrm/coforge-sdk/internal/uuid";
import type { PrismaClient } from "#src/generated/prisma/client";
import { canSeeAgent } from "#src/server/agents/agent-visibility.server";
import { personConversationAccess } from "#src/server/conversations/channel-read-access.server";
import { BROWSER_PAGE_META } from "#src/server/auth/browser-realtime-token.server";
import { resolveActorServerRole } from "#src/server/conversations/channel-authority.server";
import { fromCentrifugoProxy } from "#src/server/centrifugo/proxy-secret.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import { errorType } from "#src/server/errors/error-type.server";

/**
 * Centrifugo's subscribe and sub-refresh proxies for the browser
 * (https://centrifugal.dev/docs/server/proxy#subscribe-proxy): a page subscribes to a channel
 * without a token of its own and Centrifugo asks here, server to server, whether the connection's
 * user may hold it. One request per channel the page holds instead of one browser round trip per
 * channel, every five minutes, to fetch a token.
 *
 * Each channel is checked by the rule its token used to be issued under: a Workspace channel for
 * its members, a person's own channel for them alone, a conversation for whoever reads it
 * (`personConversationAccess`), a private Agent's channels for whoever may see it. A grant lasts
 * `SUBSCRIPTION_LIFETIME_S`; Centrifugo then asks the sub-refresh proxy, which re-runs the same
 * check, so a lost grant ends within that time even if the immediate revocation
 * (`announceConversationsRevoked`) was missed.
 *
 * A refusal is final for the page (`403`, which the client does not retry). Anything that keeps
 * the check from answering (the database down, the Web briefly away while it deploys) is a non-200
 * answer, which Centrifugo reports as its temporary internal error, and the client subscribes
 * again with backoff. Only a page's connection is answered, known by the meta its connection token
 * carries (`BROWSER_PAGE_META`): a Computer's daemon connects as its owner but holds only what the
 * connect proxy gives it, and is refused here.
 */

/** How long a grant lasts before the sub-refresh proxy checks it again. */
export const SUBSCRIPTION_LIFETIME_S = 300;

/** How long one person's Workspace role and one Agent's visibility row are reused across the
 * checks of a page's channels: a page subscribes to some 30 channels at once, and a Centrifugo
 * restart reconnects every page together. */
const LOOKUP_REUSE_MS = 5_000;

export type BrowserSubscriptionAccess = {
  /** The person's role in the Workspace, or undefined if they are not in it. */
  workspaceRole(workspaceId: string, userId: string): Promise<string | undefined>;
  /** Whether the person reads the conversation (`personConversationAccess`). */
  readsConversation(conversationId: string, userId: string): Promise<boolean>;
  /** An Agent of this Workspace with what `canSeeAgent` needs, or undefined. */
  workspaceAgent(
    workspaceId: string,
    agentId: string,
  ): Promise<{ visibility: string; ownerId: string; systemKind: string | null } | undefined>;
};

const UUID = `(${UUID_LIKE_SOURCE})`;
const CHANNELS: {
  pattern: RegExp;
  allows: (access: BrowserSubscriptionAccess, user: string, ids: string[]) => Promise<boolean>;
}[] = [
  {
    // `chat:workspace:<id>`, `agentstatus:<id>`, `agent:activity:<id>`, `presence:workspace:<id>`
    pattern: new RegExp(
      `^(?:chat:workspace|agentstatus|agent:activity|presence:workspace):${UUID}$`,
    ),
    allows: async (access, user, [workspaceId]) =>
      (await access.workspaceRole(workspaceId!, user)) !== undefined,
  },
  {
    // `chat:user:<id>`, `runtimeauth:user:<id>`: the person's own.
    pattern: new RegExp(`^(?:chat|runtimeauth):user:${UUID}$`),
    allows: async (_access, user, [userId]) => userId === user,
  },
  {
    // `agentstatus:<workspace>:<agent>`, `agent:activity:<workspace>:<agent>`: a private Agent's.
    pattern: new RegExp(`^(?:agentstatus|agent:activity):${UUID}:${UUID}$`),
    allows: async (access, user, [workspaceId, agentId]) => {
      const [role, agent] = await Promise.all([
        access.workspaceRole(workspaceId!, user),
        access.workspaceAgent(workspaceId!, agentId!),
      ]);
      return (
        role !== undefined &&
        agent !== undefined &&
        canSeeAgent({ kind: "user", userId: user, role }, agent)
      );
    },
  },
  {
    // `chat:<conversation>`: one conversation's own channel.
    pattern: new RegExp(`^chat:${UUID}$`),
    allows: (access, user, [conversationId]) => access.readsConversation(conversationId!, user),
  },
];

/** Whether the connection's user may hold the channel. */
export async function mayHoldChannel(
  access: BrowserSubscriptionAccess,
  user: string,
  channel: string,
): Promise<boolean> {
  if (!user) return false;
  for (const { pattern, allows } of CHANNELS) {
    const match = pattern.exec(channel);
    if (match) return allows(access, user, match.slice(1));
  }
  return false;
}

/** Reuses each answer for `LOOKUP_REUSE_MS`, the promise itself, so checks arriving together ask
 * once. Only a found row is kept: a refusal is final for the page, so one read just before the
 * person joined must not refuse them again; nor is a failed lookup kept. */
function reused<Args extends string[], Value>(
  lookup: (...args: Args) => Promise<Value>,
  now: () => number,
): (...args: Args) => Promise<Value> {
  // Kept in the order asked, so the stale ones are always first.
  const answers = new Map<string, { at: number; value: Promise<Value> }>();
  return (...args) => {
    const key = args.join(" ");
    const at = now();
    for (const [stale, entry] of answers) {
      if (at - entry.at < LOOKUP_REUSE_MS) break;
      answers.delete(stale);
    }
    const kept = answers.get(key);
    if (kept) return kept.value;
    const value = lookup(...args);
    answers.set(key, { at, value });
    const forget = () => {
      if (answers.get(key)?.value === value) answers.delete(key);
    };
    value.then((found) => found === undefined && forget(), forget);
    return value;
  };
}

export function browserSubscriptionAccess(
  db: PrismaClient,
  now: () => number = Date.now,
): BrowserSubscriptionAccess {
  return {
    workspaceRole: reused(
      (workspaceId: string, userId: string) => resolveActorServerRole(db, workspaceId, { userId }),
      now,
    ),
    readsConversation: async (conversationId, userId) =>
      (await personConversationAccess(db, userId, { id: conversationId })) === "read",
    workspaceAgent: reused(
      async (workspaceId: string, agentId: string) =>
        (await db.agent.findFirst({
          where: { id: agentId, workspaceId },
          select: { visibility: true, ownerId: true, systemKind: true },
        })) ?? undefined,
      now,
    ),
  };
}

let access: BrowserSubscriptionAccess | undefined;

/** The subscribe (`refresh` false) and sub-refresh (`refresh` true) routes: Centrifugo's own
 * requests only, and one `browserSubscriptionAccess` for both, so a page's checks share lookups. */
export function handleSubscriptionProxy(request: Request, refresh: boolean): Promise<Response> {
  if (!fromCentrifugoProxy(request))
    return Promise.resolve(
      Response.json(
        { error: { code: 403, message: "proxy authorization failed" } },
        { status: 403 },
      ),
    );
  const db = getDatabaseClient();
  // A non-200 answer: the page subscribes again once the database is back.
  if (!db) return Promise.resolve(new Response(null, { status: 503 }));
  return answerSubscriptionProxy(request, (access ??= browserSubscriptionAccess(db)), { refresh });
}

type ProxyRequest = { user?: unknown; channel?: unknown; meta?: unknown };

/**
 * Answers one subscribe (`refresh` false) or sub-refresh (`refresh` true) proxy request. A grant
 * carries its expiry; a refused subscribe is a `403`, a refused refresh marks the subscription
 * expired, so the page subscribes again and meets the refusal. Each answer is logged as
 * `centrifugo_proxy:subscribe` or `centrifugo_proxy:sub_refresh` with its outcome (`allow`,
 * `deny`, `temporary`) and how long it took.
 */
export async function answerSubscriptionProxy(
  request: Request,
  access: BrowserSubscriptionAccess,
  { refresh, now = Date.now }: { refresh: boolean; now?: () => number },
): Promise<Response> {
  const started = performance.now();
  let outcome: "allow" | "deny" | "temporary" = "deny";
  let failure: unknown;
  // A body that is not JSON is refused like any other.
  const body = ((await request.json().catch(() => undefined)) ?? {}) as ProxyRequest;
  const channel = typeof body.channel === "string" ? body.channel : "";
  const user = typeof body.user === "string" ? body.user : "";
  if (isRecord(body.meta) && body.meta.page === BROWSER_PAGE_META.page)
    try {
      outcome = (await mayHoldChannel(access, user, channel)) ? "allow" : "deny";
    } catch (error) {
      outcome = "temporary";
      failure = error;
    }
  const log = outcome === "temporary" ? console.warn : console.info;
  log(
    JSON.stringify({
      event: refresh ? "centrifugo_proxy:sub_refresh" : "centrifugo_proxy:subscribe",
      outcome,
      channel_namespace: channel.split(":")[0],
      duration_ms: Math.round(performance.now() - started),
      ...(failure === undefined ? {} : { error_type: errorType(failure) }),
    }),
  );
  if (outcome === "temporary") return new Response(null, { status: 503 });
  if (outcome === "deny")
    return Response.json(
      refresh
        ? { result: { expired: true } }
        : { error: { code: 403, message: "permission denied" } },
    );
  return Response.json({
    result: { expire_at: Math.floor(now() / 1000) + SUBSCRIPTION_LIFETIME_S },
  });
}

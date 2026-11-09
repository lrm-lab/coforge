import { afterAll, beforeAll, expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./browser-e2e";
import { sameOriginProxy } from "./same-origin-proxy";

/**
 * Shared harness of the DM Agent unread browser E2Es (`e2e-dm-agent-unread.e2e.ts` and
 * `e2e-dm-agent-unread-realtime.e2e.ts`): the local stack's sessions and proxies, a fresh Agent with
 * its DM per case (`newPeer`), the Agent's real send, the DM row probe, and the Workspace, Agents
 * and Computer the cases own, removed afterwards. Each test file calls `registerDmUnreadHooks()`.
 * Screenshots are written under `.amp/e2e/dm-agent-unread/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
export const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin || !["localhost", "127.0.0.1"].includes(new URL(centrifugoOrigin).hostname))
  throw new Error("COFORGE_E2E_CENTRIFUGO_URL must target local Centrifugo");
export const proxy = sameOriginProxy(origin, centrifugoOrigin);
export const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
export const artifacts = join(import.meta.dir, "../../../.amp/e2e/dm-agent-unread");
export const { browser, evaluate } = browserSession(browserPath, `dm-agent-unread-${process.pid}`);
const dms = new PrismaDirectConversationRepository(db, { oneRequest: true });
const centrifugo = createCentrifugoServerApi();
const sender = new SendDirectMessage(
  dms,
  { execute: async (_scope: unknown, persist: () => unknown) => persist() } as never,
  centrifugo,
  new CentrifugoConversationRealtime(centrifugo),
);

/** Set by the hooks; read it at test time, never destructure it at import. */
export const state = { workspaceId: "", workspaceSlug: "", computerId: "", otherChannelId: "" };
let counter = 0;
export const wsInit = join(artifacts, "ws-control-init.js");
export const wsSession = browserSession(browserPath, `dm-agent-unread-ws-${process.pid}`);
/** Holds the document response of one page while armed, so a reply can land between the server's
 * render and the client's subscribe. */
let hold: { path: string; released: Promise<void> } | null = null;
export const gatedProxy = sameOriginProxy(origin, centrifugoOrigin, {
  async afterUpstream(url) {
    if (hold && url.pathname === hold.path) await hold.released;
  },
});

export type Peer = { name: string; agentId: string; conversationId: string; memberId: string };

/** A fresh Agent with its DM with the viewer, so each case starts with nothing unread. */
export async function newPeer(label: string): Promise<Peer> {
  counter += 1;
  const name = `Unread Agent ${label}`;
  const agent = await db.agent.create({
    data: {
      workspaceId: state.workspaceId,
      ownerId: DEV_BROWSER_USER.id,
      computerId: state.computerId,
      name: `unread-agent-${label}-${process.pid}`,
      displayName: name,
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "e2e-model",
        modelProvider: "e2e-provider",
        reasoning: "balanced",
      },
    },
  });
  const conversation = await dms.getOrCreateUserAgent(
    state.workspaceId,
    DEV_BROWSER_USER.id,
    agent.id,
  );
  const member = await db.conversationMember.findUniqueOrThrow({
    where: {
      conversationId_userId: { conversationId: conversation.id, userId: DEV_BROWSER_USER.id },
    },
  });
  return { name, agentId: agent.id, conversationId: conversation.id, memberId: member.id };
}

/** The Agent replies, top level or inside the thread of `threadRootId`, through the real send. */
export function agentSays(peer: Peer, body: string, threadRootId?: string) {
  return sender.executeFromAgent({
    idempotencyKey: crypto.randomUUID(),
    workspaceId: state.workspaceId,
    agentId: peer.agentId,
    target: `@${DEV_BROWSER_USER.username}${threadRootId ? `:${threadRootId}` : ""}`,
    body,
  });
}

/** The viewer's own top-level message in the DM, as a root for a thread. */
export async function viewerSays(peer: Peer, body: string) {
  const newest = await db.message.findFirst({
    where: { conversationId: peer.conversationId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  const message = await db.message.create({
    data: {
      workspaceId: state.workspaceId,
      conversationId: peer.conversationId,
      senderMemberId: peer.memberId,
      sequence: (newest?.sequence ?? 0) + 1,
      body,
    },
  });
  await db.conversationMember.update({
    where: { id: peer.memberId },
    data: { readThroughSequence: message.sequence },
  });
  return message;
}

type Row = { count: number; badgeShown: boolean; label: string | null } | null;
/** The DM's sidebar row: the count its accessible name states, and whether a badge is laid out. */
const dmRow = (peer: Peer) => `(() => {
  const link = document.querySelector('a[href*="/dm/${peer.conversationId}"]');
  if (!link) return null;
  const badge = [...link.querySelectorAll('span[aria-hidden="true"]')].find(
    (span) => span.classList.contains("rounded-full") && span.classList.contains("tabular-nums"),
  );
  const label = link.getAttribute("aria-label");
  const match = /(\\d+) unread message/.exec(label ?? "");
  return {
    count: match ? Number(match[1]) : 0,
    badgeShown: Boolean(badge) && badge.getClientRects().length > 0,
    label,
  };
})()`;

/** The session the helpers read: the main one, or the socket-controlled one of cases 7 and 8. */
let current = { browser, evaluate };
export const session = () => current;
export const useSession = (next: typeof current) => {
  current = next;
};

/** Arms the hold on `path`'s document response; the returned function lets it through. */
export function holdDocument(path: string) {
  let release!: () => void;
  hold = { path, released: new Promise<void>((resolve) => (release = resolve)) };
  return release;
}
export const releaseHold = () => {
  hold = null;
};
export async function row(peer: Peer) {
  return current.evaluate<Row>(dmRow(peer));
}

/** Polls the row until it shows `count` (0: no badge at all), or fails naming what it shows. */
export async function expectBadge(peer: Peer, count: number, ms = 12_000) {
  const deadline = Date.now() + ms;
  let seen: Row = null;
  while (Date.now() < deadline) {
    seen = await row(peer);
    if (seen && seen.count === count && seen.badgeShown === count > 0) return;
    await Bun.sleep(150);
  }
  throw new Error(`expected the DM row to show ${count}, it shows ${JSON.stringify(seen)}`);
}

/** The row stays without a badge for a while: a missed badge cannot be told from a slow one. */
export async function expectNoBadgeSettled(peer: Peer, ms = 4_000) {
  await Bun.sleep(ms);
  const seen = await row(peer);
  expect(seen).not.toBeNull();
  expect(seen!.count).toBe(0);
  expect(seen!.badgeShown).toBe(false);
}

/** Loads a page and waits for the DM's row in the sidebar; the realtime join gets `settle` ms. */
export async function openPage(path: string, peer: Peer, settle = 3_000, base = proxy.origin) {
  await current.browser("open", `${base}/en/w/${state.workspaceSlug}${path}`);
  await waitForRow(peer);
  await Bun.sleep(settle);
}

export async function waitForRow(peer: Peer) {
  const present = `${pageHydrated} && document.querySelector('a[href*="/dm/${peer.conversationId}"]') !== null`;
  const deadline = Date.now() + 40_000;
  while (!(await current.evaluate<boolean>(present).catch(() => false))) {
    if (Date.now() > deadline) {
      const page = await current.evaluate<unknown>(
        `({ path: location.pathname, hydrated: ${pageHydrated}, anchors: [...document.querySelectorAll("a")].map((a) => a.getAttribute("href")).slice(0, 40), text: document.body.innerText.slice(0, 500) })`,
      );
      throw new Error(`the DM row never appeared: ${JSON.stringify(page)}`);
    }
    await Bun.sleep(500);
  }
}

export const shot = (name: string) => current.browser("screenshot", join(artifacts, `${name}.png`));

export function registerDmUnreadHooks() {
  beforeAll(async () => {
    await mkdir(artifacts, { recursive: true });
    await db.user.upsert({
      where: { id: DEV_BROWSER_USER.id },
      update: {},
      create: {
        id: DEV_BROWSER_USER.id,
        username: DEV_BROWSER_USER.username,
        displayName: "Unread reviewer",
        welcomedAt: new Date(),
      },
    });
    const workspace = await db.workspace.create({
      data: {
        name: "DM Agent unread",
        slug: `dm-agent-unread-${process.pid}`,
        members: { create: [{ userId: DEV_BROWSER_USER.id, role: "owner" }] },
      },
    });
    state.workspaceId = workspace.id;
    state.workspaceSlug = workspace.slug;
    const computer = await db.computer.create({
      data: { ownerId: DEV_BROWSER_USER.id, machineId: `dm-agent-unread-${process.pid}` },
    });
    state.computerId = computer.id;
    const channel = await db.conversation.create({
      data: { workspaceId: state.workspaceId, channelName: "elsewhere", description: "" },
    });
    state.otherChannelId = channel.id;
    await db.conversationMember.create({
      data: {
        workspaceId: state.workspaceId,
        conversationId: channel.id,
        userId: DEV_BROWSER_USER.id,
      },
    });
  });

  afterAll(async () => {
    await browser("close").catch(() => undefined);
    await wsSession.browser("close").catch(() => undefined);
    proxy.stop();
    gatedProxy.stop();
    await Bun.file(wsInit)
      .delete()
      .catch(() => undefined);
    if (state.workspaceId)
      await db.workspace.delete({ where: { id: state.workspaceId } }).catch(() => undefined);
    if (state.computerId)
      await db.computer.delete({ where: { id: state.computerId } }).catch(() => undefined);
    await db.$disconnect();
  });
}

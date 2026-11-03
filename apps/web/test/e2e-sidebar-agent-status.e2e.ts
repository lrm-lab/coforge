import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import { agentDisplay } from "#src/features/agents/agent-activity-presentation";
import { agentStatusChannel } from "#src/features/agents/agent-status-channel";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { browserSession, localBrowserE2e } from "./helpers/browser-e2e";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/**
 * A Direct-message row's Agent face follows that Agent's live display, as status updates arrive
 * on the Workspace's status channel (task #433: the sidebar no longer re-renders on them; the
 * face reads its own Agent). Both the viewer's own Agent and another member's public one, which
 * the sidebar lists too (an `isExtra` Agent). An online heartbeat leaves the face as it is. Needs a
 * local built Web with skip-auth, PostgreSQL, local Centrifugo and agent-browser. No model runs.
 * The suite removes its own Workspace, people and Computer. Screenshots and labels live in
 * .amp/e2e/sidebar-agent-status/.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin || !["localhost", "127.0.0.1"].includes(new URL(centrifugoOrigin).hostname))
  throw new Error("COFORGE_E2E_CENTRIFUGO_URL must target local Centrifugo");
const proxy = sameOriginProxy(origin, centrifugoOrigin);
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const artifacts = join(import.meta.dir, "../../../.amp/e2e/sidebar-agent-status");
const { browser, evaluate } = browserSession(browserPath, `sidebar-agent-status-${process.pid}`);
const centrifugo = createCentrifugoServerApi();
let workspaceId: string;
let workspaceSlug: string;
let computerId: string;
let otherUserId: string;
type Peer = { name: string; agentId: string; conversationId: string };
const peers: Record<"own" | "other", Peer> = {
  own: { name: "Status Agent", agentId: "", conversationId: "" },
  other: { name: "Colleague Agent", agentId: "", conversationId: "" },
};

/** The Agent's face on its Direct-message row in the sidebar, by its accessible name. */
const face = (peer: Peer) =>
  `document.querySelector('a[href*="/dm/${peer.conversationId}"] [role="img"]')?.getAttribute("aria-label")`;

// A display revision is microseconds since the epoch, and the page's own read of an idle Agent
// is stamped when it is read: a published one must be newer than that.
let lastRevision = 0;

function display(peer: Peer, activityKind: "working" | "thinking"): AgentDisplaySnapshot {
  lastRevision = Math.max(lastRevision + 1, Date.now() * 1000);
  return {
    protocolMajor: 1,
    workspaceId,
    computerId,
    agentId: peer.agentId,
    revision: lastRevision,
    activityKind,
    detailKind: activityKind === "working" ? "running_command" : "thinking_started",
    detail: activityKind === "working" ? "Running command" : "",
    entries: [],
    expiresAt: Date.now() + 120_000,
  };
}

/** Publishes a display snapshot as the cloud does and waits for the row's face to name it. */
async function show(peer: Peer, snapshot: AgentDisplaySnapshot) {
  const label = `${peer.name}, ${agentDisplay(snapshot).label}`;
  // Published again until shown: the page's status subscription may still be joining, and a
  // repeated revision is the same snapshot to it.
  for (let attempt = 0; attempt < 10; attempt++) {
    await centrifugo.publishJson(agentStatusChannel(workspaceId), {
      type: "agent:display",
      ...snapshot,
    });
    for (let poll = 0; poll < 10; poll++) {
      if ((await evaluate<string | null>(face(peer))) === label) return label;
      await Bun.sleep(200);
    }
  }
  throw new Error(`the face never read "${label}"; it reads "${await evaluate(face(peer))}"`);
}

async function agent(ownerId: string, name: string, displayName: string) {
  return db.agent.create({
    data: {
      workspaceId,
      ownerId,
      computerId,
      name,
      // Public, so its displays arrive on the Workspace's own status channel.
      visibility: "public",
      displayName,
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "e2e-model",
        modelProvider: "e2e-provider",
        reasoning: "balanced",
      },
    },
  });
}

beforeAll(async () => {
  await mkdir(artifacts, { recursive: true });
  await db.user.upsert({
    where: { id: DEV_BROWSER_USER.id },
    update: {},
    create: {
      id: DEV_BROWSER_USER.id,
      username: DEV_BROWSER_USER.username,
      displayName: "Status reviewer",
      welcomedAt: new Date(),
    },
  });
  const other = await db.user.create({
    data: {
      username: `status-colleague-${process.pid}`,
      displayName: "Status colleague",
      welcomedAt: new Date(),
    },
  });
  otherUserId = other.id;
  const workspace = await db.workspace.create({
    data: {
      name: "Sidebar Agent status",
      slug: `sidebar-agent-status-${process.pid}`,
      members: {
        create: [
          { userId: DEV_BROWSER_USER.id, role: "owner" },
          { userId: other.id, role: "member" },
        ],
      },
    },
  });
  workspaceId = workspace.id;
  workspaceSlug = workspace.slug;
  const computer = await db.computer.create({
    data: { ownerId: DEV_BROWSER_USER.id, machineId: `sidebar-agent-status-${process.pid}` },
  });
  computerId = computer.id;
  const dms = new PrismaDirectConversationRepository(db);
  for (const [peer, ownerId, name] of [
    [peers.own, DEV_BROWSER_USER.id, "status-agent"],
    [peers.other, other.id, "colleague-agent"],
  ] as const) {
    peer.agentId = (await agent(ownerId, name, peer.name)).id;
    peer.conversationId = (
      await dms.getOrCreateUserAgent(workspaceId, DEV_BROWSER_USER.id, peer.agentId)
    ).id;
  }
});

afterAll(async () => {
  await browser("close");
  proxy.stop();
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (computerId) await db.computer.delete({ where: { id: computerId } });
  if (otherUserId) await db.user.delete({ where: { id: otherUserId } });
  await db.$disconnect();
});

for (const which of ["own", "other"] as const)
  test(`a Direct-message row's face follows the live display of ${which === "own" ? "the viewer's own Agent" : "another member's Agent"}`, async () => {
    const peer = peers[which];
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${proxy.origin}/en/w/${workspaceSlug}/dm/${peers.own.conversationId}`);
    await browser("wait", "--fn", `${face(peer)} != null`);
    const working = await show(peer, display(peer, "working"));
    const thinking = await show(peer, display(peer, "thinking"));
    // An online heartbeat changes no display: the face keeps saying what the Agent does.
    await centrifugo.publishJson(agentStatusChannel(workspaceId), {
      agentId: peer.agentId,
      status: "active",
      expiresAt: Date.now() + 90_000,
      daemonInstanceId: "e2e-daemon",
      clientSeq: 1,
      observedAtMs: Date.now(),
    });
    await Bun.sleep(1_000);
    const afterHeartbeat = await evaluate<string>(face(peer));
    await browser("screenshot", join(artifacts, `1440-${which}.png`));
    await Bun.write(
      join(artifacts, `1440-${which}.json`),
      JSON.stringify({ working, thinking, afterHeartbeat }, null, 2),
    );
    expect(working).not.toBe(thinking);
    expect(afterHeartbeat).toBe(thinking);
  }, 120_000);

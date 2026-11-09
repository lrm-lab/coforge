import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import { agentStatusChannel } from "#src/features/agents/agent-status-channel";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, desktopPointerInitScript, localBrowserE2e } from "./helpers/browser-e2e";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/**
 * A channel's members page shows every member Agent's status to a viewer who cannot see the
 * Agent itself (task #735): another member's public Agent is an `isExtra`, whose display the
 * extras read and the shared status publications carry, and a private Agent reports through its
 * status floor on the same channel — the same display the settings strip's avatars read
 * (`useLiveAgentDisplay`). Before the fix the members page read `useAgentDisplays`, which kept
 * only the viewer's roster plus floors, so every other member's public Agent read "Status
 * unknown" while its avatar dot beside it showed the real status.
 *
 * The viewer is a plain member; the Agents belong to the Workspace owner. Needs a local built
 * Web with skip-auth, PostgreSQL, local Centrifugo and agent-browser. No model runs. The suite
 * removes its own Workspace, people, Computer and channel. Screenshots live in
 * `.amp/e2e/channel-members-agent-status/`.
 *
 * The page load's extras read is the full-display one (task #735 follow-up): a public Agent that
 * never reported reads its real "offline" snapshot instead of "Status unknown", while a private
 * Agent stays on the floor/held rule and still reads "Status unknown" until one arrives.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin || !["localhost", "127.0.0.1"].includes(new URL(centrifugoOrigin).hostname))
  throw new Error("COFORGE_E2E_CENTRIFUGO_URL must target local Centrifugo");
const proxy = sameOriginProxy(origin, centrifugoOrigin);
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const artifacts = join(import.meta.dir, "../../../.amp/e2e/channel-members-agent-status");
const { browser, evaluate, waitFor } = browserSession(
  browserPath,
  `channel-members-agent-status-${process.pid}`,
);
const centrifugo = createCentrifugoServerApi();

let workspaceId: string;
let workspaceSlug: string;
let channelId: string;
let computerId: string;
let ownerUserId: string;
const agents = {
  public: { id: "", name: "", displayName: "" },
  private: { id: "", name: "", displayName: "" },
};

let lastRevision = 0;
function revision() {
  lastRevision = Math.max(lastRevision + 1, Date.now() * 1000);
  return lastRevision;
}

const snapshot = (agentId: string, statusOnly: boolean): AgentDisplaySnapshot => ({
  protocolMajor: 1,
  workspaceId,
  computerId,
  agentId,
  revision: revision(),
  activityKind: "online",
  detailKind: "",
  detail: "",
  entries: [],
  expiresAt: Date.now() + 120_000,
  ...(statusOnly ? { statusOnly: true as const } : {}),
});

const panel = `document.querySelector('[role="dialog"][aria-label="Channel details and settings"]')`;
/** The members-page row of the Agent named `displayName`, as a page expression. */
const agentRow = (displayName: string) =>
  `[...${panel}.querySelectorAll("li")].find((row) => row.textContent.includes(${JSON.stringify(displayName)}))`;

/** Publishes a display as the cloud does and waits for the Agent's row to read its status word. */
async function show(agent: { id: string; displayName: string }, statusOnly: boolean) {
  const row = agentRow(agent.displayName);
  for (let attempt = 0; attempt < 10; attempt++) {
    await centrifugo.publishJson(agentStatusChannel(workspaceId), {
      type: "agent:display",
      ...snapshot(agent.id, statusOnly),
    });
    for (let poll = 0; poll < 10; poll++) {
      const text = await evaluate<string | null>(`${row}?.textContent ?? null`);
      if (text?.includes("Online") && !text.includes("Status unknown")) return;
      await Bun.sleep(200);
    }
  }
  throw new Error(
    `the members row never read Online; it reads "${await evaluate<string | null>(`${row}?.textContent ?? null`)}"`,
  );
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
  const owner = await db.user.create({
    data: {
      username: `members-status-owner-${process.pid}`,
      displayName: "Members status owner",
      welcomedAt: new Date(),
    },
  });
  ownerUserId = owner.id;
  const workspace = await db.workspace.create({
    data: {
      name: "Channel members Agent status",
      slug: `channel-members-status-${process.pid}`,
      members: {
        create: [
          { userId: DEV_BROWSER_USER.id, role: "member" },
          { userId: owner.id, role: "owner" },
        ],
      },
    },
  });
  workspaceId = workspace.id;
  workspaceSlug = workspace.slug;
  const computer = await db.computer.create({
    data: {
      ownerId: owner.id,
      machineId: `members-status-${process.pid}`,
      name: `members-status-${process.pid}.local`,
      displayName: "E2E Studio",
      kind: "local",
      workspaces: { create: { workspaceId } },
    },
  });
  computerId = computer.id;
  const runtimeConfig = {
    runtime: "pi",
    provider: { kind: "default" },
    model: "",
    modelProvider: "",
    reasoning: "",
  };
  for (const [key, visibility] of [
    ["public", "public"],
    ["private", "private"],
  ] as const) {
    const agent = await db.agent.create({
      data: {
        workspaceId,
        ownerId: owner.id,
        computerId: computer.id,
        name: `members-status-${key}-${process.pid}`,
        displayName: `Status ${key === "public" ? "Public" : "Private"} Agent ${process.pid}`,
        visibility,
        runtimeConfig,
      },
    });
    agents[key] = { id: agent.id, name: agent.name, displayName: agent.displayName ?? "" };
  }
  const channel = await db.conversation.create({
    data: { workspaceId, channelName: `members-status-${process.pid}`, description: "" },
  });
  channelId = channel.id;
  await db.conversationMember.createMany({
    data: [
      {
        conversationId: channel.id,
        workspaceId,
        userId: DEV_BROWSER_USER.id,
        channelRole: "member",
      },
      { conversationId: channel.id, workspaceId, agentId: agents.public.id },
      { conversationId: channel.id, workspaceId, agentId: agents.private.id },
    ],
  });
});

afterAll(async () => {
  await browser("close");
  proxy.stop();
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (computerId) await db.computer.delete({ where: { id: computerId } });
  if (ownerUserId) await db.user.delete({ where: { id: ownerUserId } });
  await db.$disconnect();
});

test("a plain member's channel roster reads another member's Agent status, public and private", async () => {
  // The desktop sections assume a mouse: a headless Linux Chrome reports a coarse pointer.
  const pointerInit = await desktopPointerInitScript(artifacts);
  await browser("--init-script", pointerInit, "set", "viewport", "1440", "900");
  await browser("open", `${proxy.origin}/en/w/${workspaceSlug}/channel/${channelId}`);
  await waitFor(
    `document.querySelector('[aria-label="Channel details and settings"]') !== null`,
    60_000,
  );
  // The settings' Members row: this channel's one human and two Agents.
  const membersRow = `[...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent.includes("1 human · 2 agents"))`;
  await browser("click", '[aria-label="Channel details and settings"]');
  await waitFor(`${panel} !== null`, 15_000);
  await waitFor(`${membersRow} !== undefined`, 15_000);
  await browser("eval", `${membersRow}.click()`);
  await waitFor(`${panel}?.querySelector('input[placeholder="Search members…"]') != null`, 15_000);

  // Neither Agent has reported a display yet. The public one's first-paint extras read already
  // answered its real offline snapshot, so its row reads "Offline"; the private one stays on the
  // floor/held rule and still reads "Status unknown" until a floor arrives.
  const publicRow = agentRow(agents.public.displayName);
  const privateRow = agentRow(agents.private.displayName);
  await waitFor(`${publicRow} !== undefined`, 15_000);
  await waitFor(`${privateRow} !== undefined`, 15_000);
  await waitFor(`${publicRow}?.textContent.includes("Offline")`, 15_000);
  await waitFor(`${privateRow}?.textContent.includes("Status unknown")`, 15_000);

  // The private Agent answers through its status floor on the shared channel; the public one
  // through its full display — both land on the same row the avatar's dot reads.
  await show(agents.private, true);
  await show(agents.public, false);

  await browser("screenshot", join(artifacts, "members-status.png"));
  for (const agent of [agents.public, agents.private]) {
    const text = await evaluate<string | null>(
      `${agentRow(agent.displayName)}?.textContent ?? null`,
    );
    expect(text).toContain("Online");
    expect(text).not.toContain("Status unknown");
  }
}, 120_000);

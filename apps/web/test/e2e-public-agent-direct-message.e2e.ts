import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * Browser E2E (task #226): a DM with another member's public Agent is listed in the viewer's
 * sidebar. Any member may message a public Agent, but the sidebar used to match a DM's Agent among
 * the viewer's own Agents only, so the DM opened and took messages yet never showed in the list.
 * The row shows as soon as the DM opens, and again after a reload.
 *
 * Opt-in like the other browser E2Es: real local Web (`COFORGE_DEV_SKIP_AUTH=1`) + `agent-browser`
 * against the dev database. It seeds one member with a public Agent and deletes what it created.
 * Screenshots are written under `.amp/e2e/public-agent-direct-message/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/public-agent-direct-message");

test("a DM with another member's public Agent is listed in the sidebar", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `public-agent-dm-${process.pid}`;
  async function browser(...args: string[]) {
    const child = Bun.spawn([browserPath!, "--session", session, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`Browser ${args[0]} failed: ${stderr}`);
    return stdout;
  }
  /** Waits for a page condition, failing with the condition after 15 s. */
  const waitFor = (condition: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      browser("wait", "--fn", condition).finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for: ${condition}`)), 15_000);
      }),
    ]);
  };
  const suffix = `${process.pid}-${Date.now()}`;
  const agentName = `Shared helper ${suffix}`;
  /** The "Private Chat" button on the Members page card of `name`. */
  const cardChat = `[...([...document.querySelectorAll('[role="row"]')].find((card) => card.querySelector("h2")?.textContent.startsWith(${JSON.stringify(agentName)}))?.querySelectorAll("button") ?? [])].find((button) => button.textContent.trim() === "Private Chat")`;
  /** Whether the sidebar lists a DM: its row card, named for the Agent. */
  const sidebarRow = (conversationId: string) =>
    `[...document.querySelectorAll('a[data-row-card][href$="/dm/${conversationId}"]')].some((row) => row.textContent.includes(${JSON.stringify(agentName)}))`;

  let peerId: string | undefined;
  let agentId: string | undefined;
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    const { workspaceId } = membership;
    const workspacePath = `/en/w/${membership.workspace.slug}`;
    const peer = await db.user.create({
      data: { username: `e2e-public-agent-owner-${suffix}`, displayName: "Agent Owner" },
    });
    peerId = peer.id;
    await db.workspaceMembership.create({ data: { workspaceId, userId: peer.id, role: "member" } });
    const agent = await db.agent.create({
      data: {
        workspaceId,
        ownerId: peer.id,
        name: `shared-helper-${suffix}`,
        displayName: agentName,
        visibility: "public",
        runtimeConfig: {
          runtime: "pi",
          provider: { kind: "default" },
          model: "e2e-model",
          modelProvider: "e2e-provider",
          reasoning: "balanced",
        },
      },
    });
    agentId = agent.id;
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");

    // The Agent's card on the Members page opens the viewer's DM with it.
    await browser("open", `${origin}${workspacePath}/members?memberType=agent&owner=all`);
    await waitFor(`Object.keys(${cardChat} ?? {}).some((key) => key.startsWith("__reactProps"))`);
    await browser("eval", `${cardChat}.click()`);
    await waitFor(`location.pathname.startsWith("${workspacePath}/dm/")`);
    const dm = await db.conversation.findFirstOrThrow({
      where: { workspaceId, members: { some: { agentId: agent.id } } },
    });

    // Listed as soon as it opens, and again after a reload.
    await waitFor(sidebarRow(dm.id));
    await browser(
      "eval",
      `document.querySelector('a[data-row-card][href$="/dm/${dm.id}"]').scrollIntoView({ block: "center" })`,
    );
    await browser("screenshot", join(artifacts, "opened.png"));
    await browser("reload");
    await waitFor(`location.pathname === "${workspacePath}/dm/${dm.id}"`);
    await waitFor(sidebarRow(dm.id));
    expect(await browser("eval", sidebarRow(dm.id))).toContain("true");
    await browser("screenshot", join(artifacts, "reloaded.png"));
  } finally {
    await browser("close").catch(() => undefined);
    if (agentId) {
      await db.conversation.deleteMany({ where: { members: { some: { agentId } } } });
      await db.agent.delete({ where: { id: agentId } });
    }
    if (peerId) {
      await db.workspaceMembership.deleteMany({ where: { userId: peerId } });
      await db.user.delete({ where: { id: peerId } });
    }
    await db.$disconnect();
  }
}, 120_000);

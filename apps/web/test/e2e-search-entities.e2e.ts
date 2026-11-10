import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";

/**
 * Channels, Agents and Computers matching the query, listed in the search dialog above the
 * messages, grouped under their kind with the closest match first in each group. A leading `#`
 * keeps only channels and a leading `@` only Agents. A channel opens itself, the viewer's own
 * Agent opens their direct conversation with it once there is one, another member's Agent its
 * profile, and a Computer its page; opening one closes the dialog.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. Seeds are deterministic
 * and reset on every run; the Computer is seed-dev's "Mac Studio". Screenshots are written under
 * `.amp/e2e/search-entities/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/search-entities");

/** Deterministic id (seed-dev's sha256→UUID shape), so a rerun updates instead of duplicating. */
function seededUuid(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

test("the search dialog lists matching channels, Agents and Computers and opens them", async () => {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  const session = `search-entities-${process.pid}`;
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
  async function evaluate<T>(expression: string): Promise<T> {
    return JSON.parse(JSON.parse(await browser("eval", `JSON.stringify(${expression})`))) as T;
  }
  /** Waits for a page condition, failing with the condition and the page text after 15 s. */
  const waitFor = (condition: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      browser("wait", "--fn", condition).finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void browser(
            "eval",
            `location.pathname + " | " + (document.querySelector('[role="dialog"]') ?? document.querySelector("main"))?.innerText`,
          )
            .catch((error: unknown) => String(error))
            .then((page) =>
              reject(new Error(`Timed out waiting for: ${condition}\nPage: ${page}`)),
            );
        }, 15_000);
      }),
    ]);
  };
  /** The dev user's Workspace pages, `/en/w/<slug>`; set once its membership is read. */
  let workspacePath = "";
  async function searchFor(query: string, expected: string[]) {
    await browser("open", `${origin}${workspacePath}/search?q=${encodeURIComponent(query)}`);
    await waitFor(
      `JSON.stringify([...document.querySelectorAll('[role="dialog"] [data-search-entity]')].map((row) => row.dataset.searchEntity)) === ${JSON.stringify(JSON.stringify(expected))}`,
    );
  }
  /** Searches and waits until `entity` is listed under the `group` heading, whatever else the
   * shared database adds to the results. */
  async function searchFinds(query: string, group: string, entity: string) {
    await browser("open", `${origin}${workspacePath}/search?q=${encodeURIComponent(query)}`);
    await waitFor(
      `document.querySelector('[role="dialog"] section[aria-label="${group}"] [data-search-entity="${entity}"]') !== null`,
    );
  }
  /** Opens a result by clicking its row, which closes the dialog. */
  async function openResult(entity: string) {
    await browser("click", `[role="dialog"] [data-search-entity="${entity}"]`);
    await waitFor(`document.querySelector('[role="dialog"]') === null`);
  }

  const channelId = seededUuid("e2e-search-entities:channel");
  const agentId = seededUuid("e2e-search-entities:agent");
  const othersAgentId = seededUuid("e2e-search-entities:others-agent");
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      // Other e2es leave the dev user in Workspaces of their own; the seed made the first one.
      where: { userId: DEV_BROWSER_USER.id },
      orderBy: { workspace: { createdAt: "asc" } },
      include: { workspace: { select: { slug: true } } },
    });
    workspacePath = `/en/w/${membership.workspace.slug}`;
    const workspaceId = membership.workspaceId;
    await db.conversation.deleteMany({ where: { id: channelId } });
    await db.conversation.deleteMany({
      where: { workspaceId, channelName: "e2e-lighthouse" },
    });
    await db.conversation.create({
      data: {
        id: channelId,
        workspaceId,
        channelName: "e2e-lighthouse",
        description: "Beacon",
      },
    });
    await db.agent.upsert({
      where: { id: agentId },
      update: { deletedAt: null, visibility: "public", workspaceId, ownerId: DEV_BROWSER_USER.id },
      create: {
        id: agentId,
        workspaceId,
        ownerId: DEV_BROWSER_USER.id,
        name: "e2e-lighthouse-bot",
        displayName: "Lighthouse Bot",
        runtimeConfig: {
          runtime: "claude-code",
          provider: { kind: "default" },
          model: "claude-opus-4-6",
          modelProvider: "",
          reasoning: "high",
        },
      },
    });
    // Another member's public Agent: visible to the viewer, but its DM is its owner's.
    const colleague = await db.user.findFirstOrThrow({
      where: { username: "jordan-lee", memberships: { some: { workspaceId } } },
    });
    await db.agent.upsert({
      where: { id: othersAgentId },
      update: { deletedAt: null, visibility: "public", workspaceId, ownerId: colleague.id },
      create: {
        id: othersAgentId,
        workspaceId,
        ownerId: colleague.id,
        name: "e2e-lighthouse-keeper",
        displayName: "Lighthouse Keeper",
        runtimeConfig: {
          runtime: "claude-code",
          provider: { kind: "default" },
          model: "claude-opus-4-6",
          modelProvider: "",
          reasoning: "high",
        },
      },
    });
    // The viewer already has a DM with their own Agent, so opening the Agent lands on it.
    const { conversationId: dmId } = await new DirectConversations(db).open(
      workspaceId,
      DEV_BROWSER_USER.id,
      { agentId },
    );
    const computer = await db.computer.findFirstOrThrow({
      where: { name: "mac-studio-01", workspaces: { some: { workspaceId } } },
    });
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");

    // Grouped under their kind: Channels, then Agents. Within the Agents the closer match is
    // first. Each row names its place, with no kind label of its own.
    await searchFor("lighthouse", [
      `channel:${channelId}`,
      `agent:${agentId}`,
      `agent:${othersAgentId}`,
    ]);
    // No message matches, so the Messages section says so under the matches.
    // Wait for it: the matches can show before the message search has answered.
    await waitFor(
      `document.querySelector('[role="dialog"]').innerText.includes("No messages match.")`,
    );
    const groups = await evaluate<Record<string, string[]>>(
      `Object.fromEntries([...document.querySelectorAll('[role="dialog"] section[aria-label]')].map((section) => [section.getAttribute("aria-label"), [...section.querySelectorAll("[data-search-entity]")].map((row) => row.dataset.searchEntity)]))`,
    );
    expect(groups).toEqual({
      Channels: [`channel:${channelId}`],
      Agents: [`agent:${agentId}`, `agent:${othersAgentId}`],
    });
    const rows = await evaluate<string[]>(
      `[...document.querySelectorAll('[role="dialog"] [data-search-entity]')].map((row) => row.textContent)`,
    );
    expect(rows[0]).toContain("#e2e-lighthouse");
    expect(rows[1]).toContain("Lighthouse Bot");
    await browser("screenshot", join(artifacts, "entities.png"));

    // `#` keeps channels only, `@` keeps Agents only.
    await searchFor("#lighthouse", [`channel:${channelId}`]);
    await searchFor("@lighthouse", [`agent:${agentId}`, `agent:${othersAgentId}`]);

    // A Computer matches by its name. Other e2es leave Computers of the same name behind, so
    // only this one's place in the Computers group is pinned.
    await searchFinds("mac studio", "Computers", `computer:${computer.id}`);

    // Opening closes the dialog and goes there: a channel opens itself, the viewer's own Agent
    // their DM with it, a Computer its page. Each opens search afresh, as the dialog keeps
    // nothing once it closes.
    const lighthouse = [`channel:${channelId}`, `agent:${agentId}`, `agent:${othersAgentId}`];
    await searchFor("lighthouse", lighthouse);
    await openResult(`channel:${channelId}`);
    await waitFor(`location.pathname === "${workspacePath}/channel/${channelId}"`);
    await searchFor("lighthouse", lighthouse);
    await openResult(`agent:${agentId}`);
    await waitFor(`location.pathname === "${workspacePath}/dm/${dmId}"`);
    // Another member's Agent opens its profile instead.
    await searchFor("lighthouse", lighthouse);
    await openResult(`agent:${othersAgentId}`);
    await waitFor(
      `location.pathname === "${workspacePath}/members" && new URLSearchParams(location.search).get("profile") === "agent:${othersAgentId}"`,
    );
    await searchFinds("mac studio", "Computers", `computer:${computer.id}`);
    await openResult(`computer:${computer.id}`);
    await waitFor(`location.pathname === "${workspacePath}/computer/${computer.id}"`);
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channelId } }).catch(() => {});
    await db.agent
      .updateMany({
        where: { id: { in: [agentId, othersAgentId] } },
        data: { deletedAt: new Date() },
      })
      .catch(() => {});
    await db.$disconnect();
  }
}, 240_000);

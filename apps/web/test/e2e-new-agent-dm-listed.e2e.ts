import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * Task #551: an Agent made with New Agent → Create and Chat opens its DM, and the DM stays in the
 * sidebar's Direct Messages without a reload, through the first message too. The sidebar lists a
 * DM with an Agent only while the page's live Agents hold that Agent; they used to be rebuilt from
 * the page's first read of the roster whenever the other members' Agents were read again, which
 * dropped the new one until a reload.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`, the seeded Computer and its
 * Claude Code runtime. The Agent and its DM are removed after the run.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();

test("a new Agent's DM stays in the sidebar without a reload", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `new-agent-dm-${process.pid}`);
  const name = `e2e-dm-${process.pid}-${Date.now().toString(36)}`;
  const { workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  try {
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}`);
    const newButton = `document.querySelector('button[aria-label="New"]')`;
    await browser("wait", "--fn", `${pageHydrated} && ${newButton} !== null`);
    await browser("click", 'button[aria-label="New"]');
    await browser("find", "role", "menuitem", "click", "--name", "New Agent", "--exact");
    await browser("find", "role", "radio", "click", "--name", "Local Computer", "--exact");
    // The local form shows once the Workspace's Computers are read.
    await browser(
      "wait",
      "--fn",
      `[...document.querySelectorAll("button")].some((el) => el.textContent.trim() === "Claude Code" || el.textContent.trim() === "CoForge")`,
    );
    await browser("find", "role", "textbox", "fill", name, "--name", "Username", "--exact");
    await browser("find", "role", "button", "click", "--name", "Runtime provider");
    await browser("find", "role", "option", "click", "--name", "Claude Code", "--exact");
    await browser("find", "role", "button", "click", "--name", "Create and Chat", "--exact");
    await browser("wait", "--fn", `location.pathname.includes("/dm/")`);

    const dmId = await evaluate<string>(`location.pathname.split("/dm/")[1]`);
    const row = `document.querySelector('a[href$="/dm/${dmId}"]')`;
    await browser("wait", "--fn", `${row} !== null`);
    expect(await evaluate<string>(`${row}.textContent`)).toContain(name);

    // The dialog closes once the DM is open.
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[role="dialog"]') === null && document.querySelector("textarea[data-composer]") !== null`,
    );
    await browser("click", "textarea[data-composer]");
    await browser("keyboard", "type", "hello");
    await browser("press", "Enter");
    await browser(
      "wait",
      "--fn",
      `[...document.querySelectorAll("[data-message-id]")].some((el) => el.textContent.includes("hello"))`,
    );
    // Members shows the other members' Agents, and reads them again with their faces: the read
    // that rebuilt the live Agents from the page's first roster.
    await browser("find", "role", "link", "click", "--name", "Members", "--exact");
    await browser("wait", "--fn", `location.pathname.endsWith("/members")`);
    await Bun.sleep(2000);
    await browser("eval", "history.back()");
    await browser("wait", "--fn", `location.pathname.includes("/dm/${dmId}")`);
    await browser("wait", "--fn", `${row} !== null`).catch(() => undefined);
    expect(await evaluate<boolean>(`${row} !== null`)).toBe(true);
  } finally {
    await browser("close").catch(() => undefined);
    const agent = await db.agent.findFirst({ where: { name }, select: { id: true } });
    if (agent) {
      await db.conversation
        .deleteMany({ where: { members: { some: { agentId: agent.id } } } })
        .catch(() => undefined);
      await db.agentMessageDelivery
        .deleteMany({ where: { agentId: agent.id } })
        .catch(() => undefined);
      await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    }
    await db.$disconnect();
  }
}, 120_000);

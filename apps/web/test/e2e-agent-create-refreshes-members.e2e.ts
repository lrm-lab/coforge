import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";

/**
 * An Agent created outside the New agent dialog, here from a channel's Add members view, shows on
 * the Members page the person opened before creating it, without a reload and without a realtime
 * event: every create goes through the one create seam, which marks the Members directory stale.
 *
 * The run loads the Members page, goes back to a seeded channel within the same page, creates an
 * Agent from the channel's Add members view, goes forward to Members again and expects its card.
 * The Members query keeps its first read fresh for 30 s, so the run checks it got back within that
 * window; later than that the card would show anyway and prove nothing. Run it against the Web
 * port, not the same-origin proxy, so no realtime event can stand in for the fix.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`, the dev user an owner of
 * its Workspace with a Computer attached (seed-dev) and its Claude Code runtime. The channel, the
 * Agent and its memberships are removed after the run. Screenshots are written under
 * `.amp/e2e/agent-create-refreshes-members/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/agent-create-refreshes-members");
const MEMBERS_FRESH_MS = 30_000;

test("an Agent created from a channel's Add members view shows on an already-read Members page", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor, clickText } = browserSession(
    browserPath,
    `agent-create-refreshes-members-${process.pid}`,
  );
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const agentName = `aa-e2e-refresh-${process.pid}`;
  const channel = await db.conversation.create({
    data: { workspaceId, channelName: `e2e-refresh-members-${process.pid}`, description: "" },
  });
  const panel = `document.querySelector('[role="dialog"][aria-label="Channel details and settings"]')`;
  const agentForm = `[...document.querySelectorAll('[role="dialog"]')].find((dialog) => dialog.querySelector('input[name="name"]'))`;
  const membersCard = `[...document.querySelectorAll('[aria-label="Agents"][role="grid"] [role="row"]')].some((row) => row.textContent.includes(${JSON.stringify(agentName)}))`;
  try {
    await db.conversationMember.create({
      data: {
        conversationId: channel.id,
        workspaceId,
        userId: DEV_BROWSER_USER.id,
        channelRole: "admin",
      },
    });
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}`);
    await waitFor(
      `${pageHydrated} && document.querySelector('[aria-label="Channel details and settings"]') !== null`,
      60_000,
    );

    await browser("eval", `document.querySelector('a[href$="/members"]').click()`);
    await waitFor(
      `document.querySelector('[aria-label="Agents"][role="grid"] [role="row"]') !== null`,
    );
    const membersReadAt = Date.now();
    expect(await evaluate<boolean>(membersCard)).toBe(false);

    await browser("eval", "history.back()");
    await waitFor(`location.pathname.endsWith(${JSON.stringify(`/channel/${channel.id}`)})`);
    for (let attempt = 0; ; attempt += 1) {
      await browser("click", '[aria-label="Channel details and settings"]');
      const opened = await waitFor(`${panel} !== null`, 5_000).then(
        () => true,
        () => false,
      );
      if (opened) break;
      if (attempt === 5) throw new Error("the channel settings panel never opened");
    }
    await waitFor(`${panel}?.querySelector('[aria-label="Add members"]') != null`);
    await browser("eval", `${panel}.querySelector('[aria-label="Add members"]').click()`);
    await browser("fill", 'input[placeholder="Name"]', agentName);
    const createEntry = `[...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent.trim().startsWith(${JSON.stringify(`Create Agent “${agentName}”`)}))`;
    await waitFor(`${createEntry} !== undefined`);
    await browser("eval", `${createEntry}.click()`);
    await waitFor(
      `${agentForm}?.querySelector('button[aria-label="Refresh model catalog"]:not([disabled])') != null`,
    );
    const picked = JSON.parse(
      await browser(
        "eval",
        `(async () => {
      const dialog = ${agentForm};
      const trigger = [...dialog.querySelectorAll('button[aria-haspopup="listbox"]')].find((button) => (button.getAttribute("aria-labelledby") ?? "").split(" ").some((id) => document.getElementById(id)?.textContent.includes("Runtime")));
      if (!trigger) return "no-trigger";
      trigger.click();
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const option = [...document.querySelectorAll('[role="option"]')].find((item) => item.textContent.includes("Claude Code"));
        if (option) {
          option.click();
          return "clicked";
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return "no-option";
    })()`,
      ),
    ) as string;
    expect(picked).toBe("clicked");
    await clickText(`[role="dialog"] button`, "Create Agent");
    await waitFor(`${agentForm} === undefined`, 30_000);

    await browser("eval", "history.forward()");
    await waitFor(`location.pathname.endsWith("/members")`);
    await waitFor(`document.querySelector('[aria-label="Agents"][role="grid"]') !== null`);
    expect(Date.now() - membersReadAt).toBeLessThan(MEMBERS_FRESH_MS - 5_000);
    await waitFor(membersCard, 5_000);
    await browser("screenshot", join(artifacts, "members.png"));
  } finally {
    await browser("close").catch(() => undefined);
    const ignore = () => undefined;
    const agent = await db.agent
      .findFirst({ where: { workspaceId, name: agentName }, select: { id: true } })
      .catch(ignore);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(ignore);
    if (agent) {
      await db.conversation
        .deleteMany({ where: { members: { some: { agentId: agent.id } } } })
        .catch(ignore);
      await db.agentMessageDelivery.deleteMany({ where: { agentId: agent.id } }).catch(ignore);
      await db.agent.deleteMany({ where: { id: agent.id } }).catch(ignore);
    }
    await db.$disconnect().catch(ignore);
  }
}, 180_000);

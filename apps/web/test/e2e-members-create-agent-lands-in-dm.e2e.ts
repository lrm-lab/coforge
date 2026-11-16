import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
 * "New agent" on the Members page ends in the new Agent's direct conversation and the person can
 * find the Agent there. Three things used to lose it: the dialog's close wrote `?setup=` back
 * through the Members route and navigated the person from the DM to Members again; the Members
 * directory kept serving its cached first page (30 s stale time) without the new Agent; and the
 * sidebar lists direct messages oldest first, so the new row sat below the sidebar's scroll
 * with nothing bringing it into view.
 *
 * The run opens `/members` and presses New Agent in a Workspace whose sidebar overflows (it seeds
 * 30 channels), creates a local Agent, then checks the page stays on `/dm/<id>` after the dialog
 * is gone, the sidebar's selected row lies inside the sidebar's scroll box, Back reaches the
 * Members page with no dialog (the create replaced the dialog's history entry), and the Members
 * page lists the Agent without a reload.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`, the dev user an owner of
 * its Workspace with a Computer attached (seed-dev) and its Claude Code runtime. The channels, the
 * Agent and its DM are removed after the run. Screenshots are written under
 * `.amp/e2e/members-create-agent-lands-in-dm/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/members-create-agent-lands-in-dm");

test("a new Agent made on the Members page lands in its DM, in view, and is listed", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor, clickText } = browserSession(
    browserPath,
    `members-create-agent-dm-${process.pid}`,
  );
  const name = `aa-e2e-members-dm-${process.pid}`;
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const channelIds = Array.from({ length: 30 }, () => randomUUID());
  const membersUrl = `${origin}/en/w/${workspace.slug}/members`;
  const selectedRow = (dmId: string) => `(() => {
    const row = document.querySelector('a[aria-current="page"][href$="/dm/${dmId}"]');
    if (!row) return null;
    let box = row.parentElement;
    while (box && getComputedStyle(box).overflowY !== "auto") box = box.parentElement;
    if (!box) return null;
    const rowRect = row.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    return {
      overflows: box.scrollHeight > box.clientHeight,
      visible: rowRect.top >= boxRect.top - 1 && rowRect.bottom <= boxRect.bottom + 1,
    };
  })()`;
  try {
    await mkdir(artifacts, { recursive: true });
    await db.conversation.createMany({
      data: channelIds.map((id, index) => ({
        id,
        workspaceId,
        channelName: `e2e-members-dm-${process.pid}-${index}`,
        description: "",
      })),
    });
    await db.conversationMember.createMany({
      data: channelIds.map((conversationId) => ({
        conversationId,
        workspaceId,
        userId: DEV_BROWSER_USER.id,
        channelRole: "admin" as const,
      })),
    });

    await browser("set", "viewport", "1440", "900");
    await browser("open", membersUrl);
    await waitFor(
      `${pageHydrated} && document.querySelector('[aria-label="Agents"][role="grid"]') !== null`,
      60_000,
    );
    await clickText("button", "New Agent");
    await waitFor(`document.querySelector('[role="dialog"] input[name="name"]') !== null`);
    expect(await evaluate<string>(`location.search`)).toContain("setup=create-agent");

    await clickText("label", "Local Computer");
    await waitFor(
      `[...document.querySelectorAll("button")].some((el) => el.textContent.trim() === "Claude Code" || el.textContent.trim() === "CoForge")`,
    );
    await browser("fill", '[role="dialog"] input[name="name"]', name);
    const runtime = `[...document.querySelectorAll("button")].find((el) => el.getAttribute("aria-label")?.endsWith("Runtime") || el.textContent.trim() === "Claude Code")`;
    if (!(await evaluate<boolean>(`${runtime}?.textContent.trim() === "Claude Code"`))) {
      await browser("find", "role", "button", "click", "--name", "Runtime");
      await browser("find", "role", "option", "click", "--name", "Claude Code", "--exact");
    }
    await browser("screenshot", join(artifacts, "form.png"));

    await browser(
      "eval",
      `(() => {
        window.__addresses = [location.pathname + location.search];
        setInterval(() => {
          const now = location.pathname + location.search;
          if (window.__addresses.at(-1) !== now) window.__addresses.push(now);
        }, 5);
      })()`,
    );
    await browser("find", "role", "button", "click", "--name", "Create and chat", "--exact");
    await waitFor(`location.pathname.includes("/dm/")`, 30_000);
    const dmId = await evaluate<string>(`location.pathname.split("/dm/")[1]`);

    await waitFor(`document.querySelector('[role="dialog"]') === null`);
    await browser("screenshot", join(artifacts, "dm.png"));
    const addresses = await evaluate<string[]>(`window.__addresses`);
    expect(
      addresses.filter((address) => address.includes("/members")).length,
      `the page left the DM for Members again: ${addresses.join(" -> ")}`,
    ).toBe(1);
    expect(addresses.at(-1)).toContain(`/dm/${dmId}`);
    expect(await evaluate<string>(`location.pathname`)).toContain(`/dm/${dmId}`);

    await waitFor(`${selectedRow(dmId)}?.visible === true`, 5_000);
    expect(await evaluate<{ overflows: boolean; visible: boolean }>(selectedRow(dmId))).toEqual({
      overflows: true,
      visible: true,
    });
    await browser("screenshot", join(artifacts, "sidebar.png"));

    await browser("eval", "history.back()");
    await waitFor(`location.pathname.endsWith("/members")`);
    await waitFor(`document.querySelector('[aria-label="Agents"][role="grid"]') !== null`);
    expect(await evaluate<string>(`location.search`)).not.toContain("setup");
    expect(await evaluate<boolean>(`document.querySelector('[role="dialog"]') !== null`)).toBe(
      false,
    );
    await browser("screenshot", join(artifacts, "back.png"));

    await waitFor(
      `[...document.querySelectorAll('[aria-label="Agents"][role="grid"] [role="row"]')].some((row) => row.textContent.includes(${JSON.stringify(name)}))`,
      10_000,
    );
    await browser("screenshot", join(artifacts, "members.png"));
  } finally {
    await browser("close").catch(() => undefined);
    const ignore = () => undefined;
    await db.conversation.deleteMany({ where: { id: { in: channelIds } } }).catch(ignore);
    const agent = await db.agent.findFirst({ where: { name }, select: { id: true } }).catch(ignore);
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

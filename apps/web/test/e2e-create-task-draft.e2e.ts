import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * The create-task dialog's owner and labels (Raft's review of e7f967b1d, in task #533): someone
 * who may not assign others is offered only themselves, as the popup offers; picking oneself
 * shows the Task as started, as the server makes it; the Task lands with its owner and label.
 *
 * Opt-in like the other browser E2Es: real local Web and `agent-browser`. A Workspace where the
 * dev user is a plain member, a peer, a channel and a label are seeded per run and removed after
 * it. Screenshots are written under `.amp/e2e/create-task-draft/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/create-task-draft");

test("a member creates a Task with themselves as owner and a label", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `create-draft-${process.pid}`);
  const tail = `${process.pid}-${Date.now()}`.slice(-8);
  const peer = await db.user.create({
    data: { username: `draft-peer-${tail}`, displayName: "Delegation peer" },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `create-draft-${tail}`,
      name: "Create draft",
      members: {
        create: [{ userId: peer.id, role: "owner" }, { userId: DEV_BROWSER_USER.id }],
      },
    },
  });
  try {
    const channel = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `drafts-${tail}`,
        description: "",
        members: { create: [{ userId: DEV_BROWSER_USER.id }, { userId: peer.id }] },
      },
    });
    const label = await db.label.create({
      data: {
        workspaceId: workspace.id,
        name: `Launch ${tail}`,
        nameKey: `launch ${tail}`,
        color: "purple",
      },
    });
    await mkdir(artifacts, { recursive: true });
    const dialog = `document.querySelector('[role="dialog"]')`;
    const mark = (expression: string, name: string) =>
      evaluate(`(${expression}.setAttribute("data-e2e", ${JSON.stringify(name)}), true)`);
    const byText = (selector: string, text: string) =>
      `[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.textContent.trim() === ${JSON.stringify(text)})`;
    const settled = `document.getAnimations().every((a) => a.playState !== "running")`;

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}?view=tasks`);
    await browser("wait", "--fn", `${pageHydrated} && ${byText("button", "Create task")} != null`);
    await mark(byText("button", "Create task"), "create-open");
    await browser("click", '[data-e2e="create-open"]');
    await browser(
      "wait",
      "--fn",
      `${dialog}?.querySelector('input[aria-label="Task title"]') != null`,
    );
    const title = `Ship the launch ${tail}`;
    await browser("fill", '[role="dialog"] input[aria-label="Task title"]', title);

    // Not a manager: the owner menu offers only the viewer.
    await browser("click", '[role="dialog"] button[aria-label="Change owner: Unassigned"]');
    const menu = `document.querySelector('[role="menu"][aria-label="Change owner"]')`;
    await browser("wait", "--fn", `${menu}?.textContent.includes("Dev User") === true`);
    expect(await evaluate<boolean>(`${menu}.textContent.includes("Delegation peer")`)).toBe(false);
    await browser("wait", "--fn", settled);
    await browser("screenshot", join(artifacts, "member-owner-menu.png"));
    await mark(byText('[role="menuitemradio"]', "Dev User"), "me");
    await browser("click", '[data-e2e="me"]');
    // Taking it on oneself makes it started: the status beside the title says so.
    await browser(
      "wait",
      "--fn",
      `${dialog}.querySelector('button[aria-label="Change owner: Dev User"]') != null && ${dialog}.querySelector("h2 .text-utility-blue-500") != null`,
    );

    // A label from the Workspace's list.
    await browser("click", '[role="dialog"] button[aria-label="Edit labels"]');
    await browser("fill", 'input[aria-label="Add or create a label…"]', label.name);
    const option = byText(
      '[role="menuitemcheckbox"], [role="menuitem"], [role="option"]',
      label.name,
    );
    await browser("wait", "--fn", `${option} != null`);
    await mark(option, "label");
    await browser("click", '[data-e2e="label"]');
    // The first Escape clears the search, the next closes the menu.
    await browser("press", "Escape");
    await browser("press", "Escape");
    await browser("wait", "--fn", `document.querySelector('[role="menu"]') == null`);
    await browser(
      "wait",
      "--fn",
      `${dialog}?.textContent.includes(${JSON.stringify(label.name)}) === true`,
    );
    await browser("wait", "--fn", settled);
    await browser("screenshot", join(artifacts, "member-draft.png"));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await browser("wait", "--fn", settled);
    await browser("screenshot", join(artifacts, "member-draft-dark.png"));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    // Enter in the title sends it, as the button does.
    await browser("click", '[role="dialog"] input[aria-label="Task title"]');
    await browser("press", "Enter");
    let row = null;
    for (let tries = 0; tries < 40 && !row; tries++) {
      row = await db.task.findFirst({
        where: { conversationId: channel.id, title },
        include: { owner: true, labels: true },
      });
      if (!row) await Bun.sleep(250);
    }
    if (!row) {
      await browser("screenshot", join(artifacts, "submit-failed.png"));
      throw new Error(
        `not created: ${await evaluate<string>(`document.querySelector('[role="dialog"]')?.textContent ?? "no dialog"`)}`,
      );
    }
    expect(row.status).toBe("in_progress");
    expect(row.owner?.userId).toBe(DEV_BROWSER_USER.id);
    expect(row.labels.map((each) => each.labelId)).toEqual([label.id]);

    // On a phone, the same sheet: taken on oneself, it reads as started.
    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}?view=tasks`);
    await browser("wait", "--fn", `${pageHydrated} && ${byText("button", "Create task")} != null`);
    await mark(byText("button", "Create task"), "create-open");
    await browser("click", '[data-e2e="create-open"]');
    await browser(
      "wait",
      "--fn",
      `${dialog}?.querySelector('input[aria-label="Task title"]') != null`,
    );
    await browser(
      "fill",
      '[role="dialog"] input[aria-label="Task title"]',
      `Call the printer ${tail}`,
    );
    await browser("click", '[role="dialog"] button[aria-label="Change owner: Unassigned"]');
    await browser("wait", "--fn", `${menu}?.textContent.includes("Dev User") === true`);
    await mark(byText('[role="menuitemradio"]', "Dev User"), "me");
    await browser("click", '[data-e2e="me"]');
    await browser("wait", "--fn", `${dialog}.querySelector("h2 .text-utility-blue-500") != null`);
    await browser("wait", "--fn", settled);
    await browser("screenshot", join(artifacts, "member-draft-phone.png"));
  } finally {
    await browser("close").catch(() => undefined);
    await db.message.deleteMany({ where: { workspaceId: workspace.id } }).catch(() => undefined);
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: peer.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);

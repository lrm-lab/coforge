import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import {
  animationsSettled,
  browserSession,
  devBrowserWorkspace,
  elementAtRest,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";

const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/task-backlog-compat");

test("Backlog column shows by default, accepts writes, and retired In Review is hidden", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor, clickText } = browserSession(
    browserPath,
    `backlog-compat-${process.pid}`,
  );
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-backlog-${process.pid}-${Date.now()}`,
      members: { create: { userId: DEV_BROWSER_USER.id } },
    },
  });
  const page = `${origin}/en/w/${workspace.slug}/channel/${channel.id}?view=tasks&layout=board`;
  const board = new TaskBoard(db);
  const backlogColumn = 'section[aria-label="Backlog"]';
  const inReviewColumn = 'section[aria-label="In review"]';
  const filter = async () => {
    await browser("find", "role", "button", "click", "--name", "Filter", "--exact");
    await clickText('[role="menuitem"]', "Status");
    await waitFor('document.querySelector(\'[role="menu"][aria-label="Status"]\') !== null');
  };
  const shoot = async (name: string) => {
    await waitFor(animationsSettled());
    await browser("screenshot", join(artifacts, `${name}.png`));
    await evaluate('document.documentElement.classList.add("dark-mode") ?? true');
    await browser("screenshot", join(artifacts, `${name}-dark.png`));
    await evaluate('document.documentElement.classList.remove("dark-mode") ?? true');
  };
  const openMenu = async (trigger: string, name: string) => {
    await waitFor(elementAtRest(`document.querySelector(${JSON.stringify(trigger)})`));
    await browser("click", trigger);
    try {
      await waitFor("document.querySelector('[role=\"menu\"]') !== null");
    } catch (error) {
      await browser("screenshot", join(artifacts, `${name}-timeout.png`)).catch(() => undefined);
      throw error;
    }
  };
  try {
    const create = (title: string, status?: "backlog" | "todo") =>
      board.execute(
        { workspaceId, userId: DEV_BROWSER_USER.id },
        {
          operation: "create",
          idempotencyKey: crypto.randomUUID(),
          conversationId: channel.id,
          title,
          ...(status ? { status } : {}),
        },
      );
    const parked = (await create("Parked fixture", "backlog")).tasks[0]!;
    const ready = (await create("Ready fixture")).tasks[0]!;
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await browser("open", page);
    await waitFor(
      `${pageHydrated} && document.querySelector('${backlogColumn}')?.textContent.includes("Parked fixture")`,
    );
    expect(await evaluate(`document.querySelector('${inReviewColumn}') === null`)).toBe(true);
    await shoot("with-backlog");
    await filter();
    expect(
      await evaluate(
        'document.querySelector(\'[role="menu"][aria-label="Status"]\').textContent.includes("Backlog")',
      ),
    ).toBe(true);
    expect(
      await evaluate(
        'document.querySelector(\'[role="menu"][aria-label="Status"]\').textContent.includes("In review")',
      ),
    ).toBe(false);
    await clickText('[role="menuitemcheckbox"]', "Backlog");
    await browser("press", "Escape");
    await browser("press", "Escape");
    await waitFor(
      `new URL(location.href).searchParams.get("status") === "backlog" && document.querySelector('${backlogColumn}')?.textContent.includes("Parked fixture")`,
    );
    expect(
      await evaluate(
        'Array.from(document.querySelectorAll("article")).some((row) => row.textContent.includes("Ready fixture"))',
      ),
    ).toBe(false);
    await browser("open", `${page.replace("layout=board", "layout=list")}&status=backlog`);
    await waitFor(`${pageHydrated} && document.body.textContent.includes("Parked fixture")`);
    await browser("set", "viewport", "390", "844");
    await shoot("backlog-list-phone");
    await browser("set", "viewport", "1440", "900");
    await browser(
      "open",
      `${origin}/en/w/${workspace.slug}/channel/${channel.id}?task=${parked.number}`,
    );
    await waitFor(
      `${pageHydrated} && document.querySelector('[role="dialog"] button[aria-label="Change status: Backlog"]') !== null`,
    );
    await openMenu(
      '[role="dialog"] button[aria-label="Change status: Backlog"]',
      "backlog-status-menu",
    );
    expect(
      await evaluate(
        'Array.from(document.querySelectorAll(\'[role="menuitem"]\')).some((row) => row.textContent.trim() === "In review")',
      ),
    ).toBe(false);
    await shoot("backlog-status-menu");
    await browser(
      "open",
      `${origin}/en/w/${workspace.slug}/channel/${channel.id}?task=${ready.number}`,
    );
    await waitFor(
      `${pageHydrated} && document.querySelector('[role="dialog"] button[aria-label="Change status: To do"]') !== null`,
    );
    await openMenu('[role="dialog"] button[aria-label="Change status: To do"]', "todo-status-menu");
    expect(
      await evaluate(
        'Array.from(document.querySelectorAll(\'[role="menuitem"]\')).some((row) => row.textContent.trim() === "Backlog")',
      ),
    ).toBe(true);
    expect(
      await evaluate(
        'Array.from(document.querySelectorAll(\'[role="menuitem"]\')).some((row) => row.textContent.trim() === "In review")',
      ),
    ).toBe(false);
  } finally {
    await browser("close").catch(() => undefined);
    try {
      await db.conversation.delete({ where: { id: channel.id } });
    } finally {
      await db.$disconnect();
    }
  }
}, 120_000);

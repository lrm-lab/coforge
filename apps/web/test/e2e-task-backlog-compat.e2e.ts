import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";

const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/task-backlog-compat");

test("Backlog read compatibility stays invisible until data exists and never offers writes", async () => {
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
  let constraint: string | undefined;
  let expanded = false;
  const backlogColumn = 'section[aria-label="Backlog"]';
  const filter = async () => {
    await browser("find", "role", "button", "click", "--name", "Filter", "--exact");
    await clickText('[role="menuitem"]', "Status");
    await waitFor('document.querySelector(\'[role="menu"][aria-label="Status"]\') !== null');
  };
  const shoot = async (name: string) => {
    await waitFor(
      'document.getAnimations().every((animation) => animation.playState !== "running")',
    );
    await browser("screenshot", join(artifacts, `${name}.png`));
    await evaluate('document.documentElement.classList.add("dark-mode") ?? true');
    await browser("screenshot", join(artifacts, `${name}-dark.png`));
    await evaluate('document.documentElement.classList.remove("dark-mode") ?? true');
  };
  try {
    const create = (title: string) =>
      board.execute(
        { workspaceId, userId: DEV_BROWSER_USER.id },
        {
          operation: "create",
          idempotencyKey: crypto.randomUUID(),
          conversationId: channel.id,
          title,
        },
      );
    const parked = (await create("Parked fixture")).tasks[0]!;
    const ready = (await create("Ready fixture")).tasks[0]!;
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await browser("open", page);
    await waitFor(`${pageHydrated} && document.body.textContent.includes("Parked fixture")`);
    expect(await evaluate(`document.querySelector('${backlogColumn}') === null`)).toBe(true);
    await filter();
    expect(
      await evaluate(
        'document.querySelector(\'[role="menu"][aria-label="Status"]\').textContent.includes("Backlog")',
      ),
    ).toBe(false);
    await browser("press", "Escape");
    await browser("press", "Escape");
    await shoot("without-backlog");

    const rows = await db.$queryRaw<
      { definition: string }[]
    >`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'tasks'::regclass AND conname = 'tasks_status_check'`;
    constraint = rows[0]!.definition;
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
      await tx.$executeRawUnsafe('ALTER TABLE "tasks" DROP CONSTRAINT "tasks_status_check"');
      await tx.$executeRawUnsafe(
        `ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_check" CHECK (status IN ('backlog','todo','in_progress','in_review','done','closed')) NOT VALID`,
      );
      await tx.task.update({ where: { id: parked.id }, data: { status: "backlog" } });
    });
    expanded = true;
    await browser("open", page);
    await waitFor(
      `${pageHydrated} && document.querySelector('${backlogColumn}')?.textContent.includes("Parked fixture")`,
    );
    expect(
      await evaluate(
        `document.querySelector('${backlogColumn}').querySelector('button[aria-label="Add a task to Backlog"]') === null`,
      ),
    ).toBe(true);
    await shoot("with-backlog");
    await filter();
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
    await browser("click", '[role="dialog"] button[aria-label="Change status: Backlog"]');
    await waitFor("document.querySelector('[role=\"menu\"]') !== null");
    expect(
      await evaluate(
        'Array.from(document.querySelectorAll(\'[role="menuitem"]\')).filter((row) => row.textContent.trim() === "Backlog").length <= 1',
      ),
    ).toBe(true);
    await shoot("backlog-status-menu");
    await browser(
      "open",
      `${origin}/en/w/${workspace.slug}/channel/${channel.id}?task=${ready.number}`,
    );
    await waitFor(
      `${pageHydrated} && document.querySelector('[role="dialog"] button[aria-label="Change status: To do"]') !== null`,
    );
    await browser("click", '[role="dialog"] button[aria-label="Change status: To do"]');
    await waitFor("document.querySelector('[role=\"menu\"]') !== null");
    expect(
      await evaluate(
        'Array.from(document.querySelectorAll(\'[role="menuitem"]\')).some((row) => row.textContent.trim() === "Backlog")',
      ),
    ).toBe(false);
  } finally {
    await browser("close").catch(() => undefined);
    try {
      await db.conversation.delete({ where: { id: channel.id } });
    } finally {
      try {
        if (expanded && constraint)
          await db.$transaction(async (tx) => {
            await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
            await tx.$executeRawUnsafe('ALTER TABLE "tasks" DROP CONSTRAINT "tasks_status_check"');
            await tx.$executeRawUnsafe(
              `ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_check" ${constraint}`,
            );
          });
      } finally {
        await db.$disconnect();
      }
    }
  }
}, 120_000);

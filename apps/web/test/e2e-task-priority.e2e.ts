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

/**
 * A Task's priority on the web (task #618): its popup shows it and changes it, on a desktop's
 * sidebar and a phone's chips, and a channel's new Task form sets it. Screenshots, light, dark and
 * phone, are written under `.amp/e2e/task-priority/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/task-priority");

test("a Task's popup and the new Task form set its priority", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `task-priority-${process.pid}`);
  const tail = `${process.pid}-${Date.now()}`;
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-priority-${tail}`,
      description: "",
      members: { create: { userId: DEV_BROWSER_USER.id } },
    },
  });
  const settled = () =>
    browser("wait", "--fn", `document.getAnimations().every((a) => a.playState !== "running")`);
  const shots = async (name: string) => {
    await settled();
    await browser("screenshot", join(artifacts, `${name}.png`));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await settled();
    await browser("screenshot", join(artifacts, `${name}-dark.png`));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  };
  const priorityOf = async (number: number) =>
    (
      await db.task.findFirstOrThrow({
        where: { conversationId: channel.id, number },
        select: { priority: true },
      })
    ).priority;
  const trigger = (label: string) =>
    `[role="dialog"] button[aria-label^="Change priority: ${label}"]`;
  const page = `${origin}/en/w/${workspace.slug}/channel/${channel.id}`;
  try {
    const { tasks } = await new TaskBoard(db).execute(
      { workspaceId, userId: DEV_BROWSER_USER.id },
      {
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        operation: "create",
        title: `Plan the launch ${tail}`,
      } as Parameters<TaskBoard["execute"]>[1],
    );
    const number = tasks[0]!.number;
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${page}?task=${number}`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.querySelector('${trigger("No priority")}') != null`,
    );

    // The popup starts at none, and a pick is saved.
    await browser("click", trigger("No priority"));
    await browser("find", "role", "menuitemradio", "click", "--name", "High");
    await browser("wait", "--fn", `document.querySelector('${trigger("High")}') != null`);
    expect(await priorityOf(number)).toBe("high");
    await shots("popup");

    // A phone shows it as a chip, and changes it the same way.
    await browser("set", "viewport", "390", "844");
    await browser("open", `${page}?task=${number}`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.querySelector('${trigger("High")}') != null`,
    );
    // The popup rises into place: a tap while it moves lands where the chip was (the skeleton's
    // endless pulse aside).
    await browser(
      "wait",
      "--fn",
      `document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity)`,
    );
    await browser("click", trigger("High"));
    // The phone's menu comes up as a sheet: wait for it before picking.
    await browser(
      "wait",
      "--fn",
      `[...document.querySelectorAll('[role="menuitemradio"]')].some((el) => el.textContent.includes("Urgent"))`,
    );
    await browser("find", "role", "menuitemradio", "click", "--name", "Urgent");
    await browser("wait", "--fn", `document.querySelector('${trigger("Urgent")}') != null`);
    expect(await priorityOf(number)).toBe("urgent");
    await shots("popup-phone");

    // The new Task form on a channel's Tasks tab.
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${page}?view=tasks`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && [...document.querySelectorAll("button")].some((el) => el.textContent.trim() === "Create task")`,
    );
    await browser("find", "role", "button", "click", "--name", "Create task");
    await browser("wait", "--fn", `document.querySelector('${trigger("No priority")}') != null`);
    await browser("fill", '[role="dialog"] [aria-label="Task title"]', `Book the room ${tail}`);
    await browser("click", trigger("No priority"));
    await browser("find", "role", "menuitemradio", "click", "--name", "Low");
    await browser("wait", "--fn", `document.querySelector('${trigger("Low")}') != null`);
    await shots("create");
    await browser("click", '[role="dialog"] button[type="submit"]');
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[role="dialog"] [aria-label="Task title"]') == null`,
    );
    const made = await db.task.findFirstOrThrow({
      where: { conversationId: channel.id, title: `Book the room ${tail}` },
      select: { priority: true },
    });
    expect(made.priority).toBe("low");

    // The mark shows on the board's cards and in its list, for the eye and for a screen reader.
    for (const layout of ["board", "list"] as const) {
      await browser("open", `${origin}/en/w/${workspace.slug}/tasks?layout=${layout}`);
      await browser(
        "wait",
        "--fn",
        `${pageHydrated} && [...document.querySelectorAll('[role="img"][aria-label="Priority: Low"]')].some((mark) => mark.getBoundingClientRect().width > 0)`,
      );
      await shots(`marks-${layout}`);
    }
    await browser("set", "viewport", "390", "844");
    await browser("reload");
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && [...document.querySelectorAll('[role="img"][aria-label="Priority: Low"]')].some((mark) => mark.getBoundingClientRect().width > 0)`,
    );
    await shots("marks-list-phone");
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);

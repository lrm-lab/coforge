import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * The Task popup's ··· menu sets a parent, adds a Task to wait on and adds a sub-task, each from a
 * dialog of its own, on a wide screen and on a phone. In production all three threw the moment
 * they were chosen (`Cannot read properties of null (reading 'isDisabled')`): the dialogs sat
 * inside React Aria's Tabs, which renders its contents once more without a menu's contexts. Each
 * change is saved and then shows in the popup, with no page error on the way.
 *
 * Opt-in like the other browser E2Es: real local Web started as it is, and `agent-browser`. The channel and its
 * Tasks are seeded per run and removed after it. Screenshots, light and dark, desktop and phone,
 * are written under `.amp/e2e/task-relation-pickers/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/task-relation-pickers");

test("the Task popup's menu sets a parent, a Task to wait on and a sub-task", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `task-pickers-${process.pid}`);
  const board = new TaskBoard(db);
  const experiments = new PrismaExperimentsRepository(db);
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const as = { workspaceId, userId: DEV_BROWSER_USER.id };
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-pickers-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }] },
    },
  });
  const before = (await experiments.read(workspaceId)).taskConversations;
  try {
    await experiments.write(workspaceId, "taskConversations", true);
    const create = async (titles: string[]) =>
      (
        await board.execute(as, {
          idempotencyKey: crypto.randomUUID(),
          conversationId: channel.id,
          operation: "create",
          titles,
        } as Parameters<TaskBoard["execute"]>[1])
      ).tasks.map((each) => each.number);

    const dialogs = `[...document.querySelectorAll('[role="dialog"]')]`;
    const items = `[...document.querySelectorAll('[role="menuitem"]')]`;
    const mark = async (selector: string, name: string) => {
      expect(
        await evaluate<boolean>(
          `(() => { const el = ${selector}; if (!el) return false; el.setAttribute("data-e2e", ${JSON.stringify(name)}); return true; })()`,
        ),
      ).toBe(true);
    };
    const shoot = async (name: string) => {
      await browser(
        "wait",
        "--fn",
        `document.getAnimations().every((a) => a.playState !== "running")`,
      );
      await browser("screenshot", join(artifacts, `${name}.png`));
      await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
      await browser("screenshot", join(artifacts, `${name}-dark.png`));
      await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    };
    const noPageErrors = async () => {
      expect((await browser("errors")).trim()).toBe("");
    };
    await mkdir(artifacts, { recursive: true });

    for (const [width, height, label] of [
      ["1280", "860", "desktop"],
      ["390", "844", "phone"],
    ] as const) {
      const [epic, design, task] = await create([
        `Launch epic ${label} ${tail}`,
        `Design review ${label} ${tail}`,
        `Build the page ${label} ${tail}`,
      ]);
      const title = `Build the page ${label} ${tail}`;
      const popup = `${dialogs}.find((el) => el.textContent.includes(${JSON.stringify(title)}) && el.querySelector('[aria-label^="More Actions"]'))`;
      const page = `${origin}/en/w/${workspace.slug}/channel/${channel.id}?task=${task}`;
      const menu = async (item: string) => {
        // The last picker has closed and faded out, so nothing lies over the popup.
        await browser(
          "wait",
          "--fn",
          `${dialogs}.length === 1 && document.getAnimations().every((a) => a.playState !== "running")`,
        );
        await mark(
          `${popup}?.querySelector('[aria-label^="More Actions for Task #${task}"]')`,
          "more",
        );
        await browser("click", '[data-e2e="more"]');
        const named = `${items}.find((el) => el.textContent.includes(${JSON.stringify(item)}))`;
        await browser("wait", "--fn", `${named} !== undefined`);
        await mark(named, "item");
        await browser("click", '[data-e2e="item"]');
      };
      const pick = async (heading: string, picked: string, shot: string) => {
        const named = `${items}.find((el) => el.textContent.includes(${JSON.stringify(picked)}))`;
        await browser(
          "wait",
          "--fn",
          `${dialogs}.some((el) => el.textContent.includes(${JSON.stringify(heading)})) && ${named} !== undefined`,
        );
        await shoot(`${label}-${shot}`);
        await mark(named, "pick");
        await browser("click", '[data-e2e="pick"]');
      };

      await browser("set", "viewport", width, height);
      await browser("open", page);
      await browser("wait", "--fn", `${pageHydrated} && ${popup} !== undefined`);
      await browser("errors", "--clear");

      // A parent: the picker opens, and the parent shows above the title.
      await menu("Set parent task");
      await pick("Choose a parent task", `Launch epic ${label} ${tail}`, "parent-picker");
      await browser(
        "wait",
        "--fn",
        `${popup}?.textContent.includes("Launch epic ${label} ${tail}") === true`,
      );
      await noPageErrors();
      const row = await db.task.findFirstOrThrow({
        where: { conversationId: channel.id, number: task },
        include: { parentLinks: { include: { parent: { select: { number: true } } } } },
      });
      expect(row.parentLinks.map((link) => link.parent.number)).toEqual([epic!]);

      // A Task to wait on: it shows under Blocked by.
      await menu("Add a task to wait on");
      await pick("Choose a task to wait on", `Design review ${label} ${tail}`, "blocker-picker");
      await browser(
        "wait",
        "--fn",
        `${popup}?.textContent.includes("Design review ${label} ${tail}") === true`,
      );
      await noPageErrors();
      expect(
        (
          await db.taskDependency.findMany({
            where: { OR: [{ taskId: row.id }, { blockedByTaskId: row.id }] },
          })
        ).length,
      ).toBe(1);

      // A sub-task, from its own create dialog.
      await menu("Add sub-task");
      const field = '[role="dialog"] input[placeholder="Task 1"]';
      await browser("wait", "--fn", `document.querySelector('${field}') !== null`);
      await browser("fill", field, `Write the copy ${label} ${tail}`);
      await shoot(`${label}-subtask-dialog`);
      await mark(
        `[...document.querySelectorAll('[role="dialog"] button')].find((el) => el.textContent.trim() === "Create Task")`,
        "create",
      );
      await browser("click", '[data-e2e="create"]');
      await browser("wait", "--fn", `${dialogs}.length === 1`);
      await noPageErrors();
      let link = null;
      for (let tries = 0; tries < 40 && !link; tries++) {
        link = await db.taskParent.findFirst({
          where: { parentTaskId: row.id, task: { title: `Write the copy ${label} ${tail}` } },
        });
        if (!link) await Bun.sleep(250);
      }
      expect(link).not.toBeNull();
      // The popup lists it under its Sub-tasks tab, read afresh: the copy that follows by
      // announcement needs the realtime connection this run has no proxy for.
      await browser("open", page);
      await browser(
        "wait",
        "--fn",
        `${pageHydrated} && [...(${popup}?.querySelectorAll('[role="tab"]') ?? [])].some((el) => el.textContent.includes("Sub-tasks"))`,
      );
      await shoot(`${label}-done`);
      void design;
    }
  } finally {
    await browser("close").catch(() => undefined);
    await experiments.write(workspaceId, "taskConversations", before).catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 240_000);

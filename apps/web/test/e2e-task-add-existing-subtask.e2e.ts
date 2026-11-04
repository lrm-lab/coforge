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
 * "Set an existing task as sub-task" (task #505): from the Task popup's ··· menu, a search over the
 * channel's unfinished Tasks. The Task above the open one is listed greyed ("Above this task"); one
 * under another parent says so, and picking it first asks whether to move it. Each pick is saved
 * as the picked Task's parent. On a wide screen and on a phone.
 *
 * Opt-in like the other browser E2Es: real local Web started as it is, and `agent-browser`. The
 * channel and its Tasks are seeded per run and removed after it. Screenshots, light and dark,
 * desktop and phone, are written under `.amp/e2e/task-add-existing-subtask/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/task-add-existing-subtask");

test("an existing Task is put under the open one, and one under another parent is moved", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `task-existing-${process.pid}`);
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
      channelName: `e2e-existing-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }] },
    },
  });
  const before = (await experiments.read(workspaceId)).taskConversations;
  try {
    await experiments.write(workspaceId, "taskConversations", true);
    const create = async (titles: string[], parent?: number) =>
      (
        await board.execute(as, {
          idempotencyKey: crypto.randomUUID(),
          conversationId: channel.id,
          operation: "create",
          titles,
          ...(parent !== undefined && { parent: { number: parent } }),
        } as Parameters<TaskBoard["execute"]>[1])
      ).tasks.map((each) => each.number);
    const parentOf = async (number: number) =>
      (
        await db.task.findFirstOrThrow({
          where: { conversationId: channel.id, number },
          include: { parentLinks: { include: { parent: { select: { number: true } } } } },
        })
      ).parentLinks[0]?.parent.number ?? null;

    const dialogs = `[...document.querySelectorAll('[role="dialog"]')]`;
    const items = `[...document.querySelectorAll('[role="menuitem"]')]`;
    const mark = async (selector: string, name: string) => {
      expect(
        await evaluate<boolean>(
          `(() => { const el = ${selector}; if (!el) return false; el.setAttribute("data-e2e", ${JSON.stringify(name)}); return true; })()`,
        ),
      ).toBe(true);
    };
    const settled = `document.getAnimations().every((a) => a.playState !== "running")`;
    const shoot = async (name: string) => {
      await browser("wait", "--fn", settled);
      await browser("screenshot", join(artifacts, `${name}.png`));
      await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
      await browser("screenshot", join(artifacts, `${name}-dark.png`));
      await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    };
    await mkdir(artifacts, { recursive: true });

    for (const [width, height, label] of [
      ["1280", "860", "desktop"],
      ["390", "844", "phone"],
    ] as const) {
      const name = (what: string) => `${what} ${label} ${tail}`;
      const [epic, old] = await create([name("Launch epic"), name("Old project")]);
      const [task] = await create([name("Build the page")], epic);
      const [docs] = await create([name("Write the docs")]);
      const [login] = await create([name("Fix login")], old);
      const popup = `${dialogs}.find((el) => el.textContent.includes(${JSON.stringify(name("Build the page"))}) && el.querySelector('[aria-label^="More Actions"]'))`;
      const item = (text: string) =>
        `${items}.find((el) => el.textContent.includes(${JSON.stringify(text)}))`;
      const openPicker = async () => {
        await browser("wait", "--fn", `${dialogs}.length === 1 && ${settled}`);
        await mark(
          `${popup}?.querySelector('[aria-label^="More Actions for Task #${task}"]')`,
          "more",
        );
        await browser("click", '[data-e2e="more"]');
        await browser("wait", "--fn", `${item("Set an existing task as sub-task")} !== undefined`);
        await mark(item("Set an existing task as sub-task"), "item");
        await browser("click", '[data-e2e="item"]');
        // "Fix login" is listed both times: under another parent until it is moved here.
        await browser(
          "wait",
          "--fn",
          `${dialogs}.some((el) => el.textContent.includes("Choose a task to add as a sub-task")) && ${item(name("Fix login"))} !== undefined && ${settled}`,
        );
      };

      await browser("set", "viewport", width, height);
      await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}?task=${task}`);
      await browser("wait", "--fn", `${pageHydrated} && ${popup} !== undefined`);
      await browser("errors", "--clear");

      // The list: the Task above is greyed with why, the one under another parent says where.
      await openPicker();
      const row = (title: string) =>
        evaluate<{ text: string; disabled: boolean } | null>(
          `(() => { const el = ${item(title)}; return el ? { text: el.textContent, disabled: el.getAttribute("aria-disabled") === "true" } : null; })()`,
        );
      expect(await row(name("Launch epic"))).toMatchObject({ disabled: true });
      expect((await row(name("Launch epic")))!.text).toContain("Above this task");
      expect((await row(name("Fix login")))!.text).toContain(`Under #${old}`);
      expect(await row(name("Write the docs"))).toMatchObject({ disabled: false });
      expect(await row(name("Build the page"))).toBeNull();
      await shoot(`${label}-picker`);

      // A free Task joins at once.
      await mark(item(name("Write the docs")), "pick");
      await browser("click", '[data-e2e="pick"]');
      await browser("wait", "--fn", `${dialogs}.length === 1`);
      for (let tries = 0; (await parentOf(docs!)) !== task && tries < 50; tries += 1)
        await Bun.sleep(100);
      expect(await parentOf(docs!)).toBe(task);

      // One under another parent asks first, then moves.
      await openPicker();
      // Now a sub-task, it is no longer offered.
      expect(await row(name("Write the docs"))).toBeNull();
      await mark(item(name("Fix login")), "pick");
      await browser("click", '[data-e2e="pick"]');
      await browser(
        "wait",
        "--fn",
        `${dialogs}.some((el) => el.textContent.includes("Move #${login} here?")) && ${settled}`,
      );
      expect(
        await evaluate<string>(
          `${dialogs}.find((el) => el.textContent.includes("Move #${login} here?")).textContent`,
        ),
      ).toContain(`#${login} is a sub-task of #${old}. It will move under #${task}.`);
      await shoot(`${label}-move`);
      await mark(
        `[...document.querySelectorAll("button")].find((el) => el.textContent.trim() === "Move")`,
        "move",
      );
      await browser("click", '[data-e2e="move"]');
      for (let tries = 0; (await parentOf(login!)) !== task && tries < 50; tries += 1)
        await Bun.sleep(100);
      expect(await parentOf(login!)).toBe(task);

      // The sub-tasks tab lists both, with the new button beside "Add sub-task". Read afresh, as
      // e2e-task-relation-pickers does: the popup's own copy follows by announcement.
      await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}?task=${task}`);
      await browser(
        "wait",
        "--fn",
        `${pageHydrated} && [...(${popup}?.querySelectorAll('[role="tab"]') ?? [])].some((el) => el.textContent.startsWith("Sub-tasks"))`,
      );
      await mark(
        `[...(${popup}?.querySelectorAll('[role="tab"]') ?? [])].find((el) => el.textContent.startsWith("Sub-tasks"))`,
        "tab",
      );
      await browser("click", '[data-e2e="tab"]');
      await browser(
        "wait",
        "--fn",
        `${popup}?.textContent.includes(${JSON.stringify(name("Write the docs"))}) && ${popup}?.textContent.includes(${JSON.stringify(name("Fix login"))}) && ${popup}?.textContent.includes("Add existing task")`,
      );
      await shoot(`${label}-subtasks`);
      expect((await browser("errors")).trim()).toBe("");
    }
  } finally {
    await browser("close").catch(() => undefined);
    await experiments.write(workspaceId, "taskConversations", before).catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 240_000);

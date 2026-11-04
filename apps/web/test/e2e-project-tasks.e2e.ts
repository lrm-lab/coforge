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
 * A Project's Tasks (tasks #460, #504): the Project page's Overview lists its Tasks in progress, up
 * next (a sub-task under its main Task) and recently done; its Tasks tab is the Project's board,
 * with no Project to pick or show, on a phone the same groups; a Task opens its popup over the
 * page. A Task's popup files it under another Project and back. Desktop and phone, light and
 * dark.
 *
 * Opt-in like the other browser E2Es: real local Web started as it is and
 * `agent-browser`. Two Projects, a channel
 * in the first and its Tasks are seeded per run and removed after it. Screenshots are written
 * under `.amp/e2e/project-tasks/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/project-tasks");

test("a Project page lists its Tasks as a tree, and a Task's popup moves it between Projects", async () => {
  // Sub-tasks are Tasks v2, part of the Workspace's `taskConversations` experiment.
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `project-tasks-${process.pid}`);
  const experiments = new PrismaExperimentsRepository(db);
  const board = new TaskBoard(db);
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  const home = await db.project.create({
    data: {
      workspaceId,
      name: `Launch ${tail}`,
      slug: `launch-${tail}`,
      description: "The new marketing site: copy, domain and launch checklist.",
    },
  });
  const other = await db.project.create({
    data: { workspaceId, name: `Docs ${tail}`, slug: `docs-${tail}` },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-project-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }] },
    },
  });
  const before = (await experiments.read(workspaceId)).taskConversations;
  try {
    await experiments.write(workspaceId, "taskConversations", true);
    const run = (command: Record<string, unknown>) =>
      board.execute({ workspaceId, userId: DEV_BROWSER_USER.id }, {
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        ...command,
      } as Parameters<TaskBoard["execute"]>[1]);
    const mainTitle = `Ship the site ${tail}`;
    const subTitle = `Write the copy ${tail}`;
    const loneTitle = `Pick a domain ${tail}`;
    // A Task carries its own Project (task #484): named at creation, or its parent's.
    const project = home.slug;
    const main = (await run({ operation: "create", title: mainTitle, project })).tasks[0]!.number;
    await run({ operation: "create", title: subTitle, parent: { number: main } });
    const lone = (await run({ operation: "create", title: loneTitle, project })).tasks[0]!.number;
    const projectOf = async (number: number) =>
      (
        await db.task.findFirstOrThrow({
          where: { conversationId: channel.id, number },
          select: { project: { select: { slug: true } } },
        })
      ).project?.slug ?? null;

    await mkdir(artifacts, { recursive: true });
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
    const projectPage = `${origin}/zh-CN/w/${workspace.slug}/projects/${home.slug}`;
    // The sub-task's row sits in a list nested in its main Task's item.
    const nested = `[...document.querySelectorAll("li li")].some((li) => li.textContent.includes(${JSON.stringify(subTitle)}))`;
    for (const [width, height, label] of [
      [1280, 860, "desktop"],
      [390, 844, "phone"],
    ] as const) {
      await browser("set", "viewport", String(width), String(height));
      await browser("open", projectPage);
      await browser(
        "wait",
        "--fn",
        `${pageHydrated} && document.body.textContent.includes(${JSON.stringify(loneTitle)})`,
      );
      expect(await evaluate<boolean>(nested)).toBe(true);
      expect(
        await evaluate<boolean>(`document.body.textContent.includes(${JSON.stringify(mainTitle)})`),
      ).toBe(true);
      await shoot(`${label}-project-page`);
    }

    // A finished Task shows under "Recently done"; one in progress under "In progress".
    const doneTitle = `Draft the brief ${tail}`;
    const done = (await run({ operation: "create", title: doneTitle, project })).tasks[0]!.number;
    // A claim gives each an owner and puts it in progress; one then moves on to Done.
    await run({ operation: "claim", number: done });
    await run({ operation: "update", number: done, status: "done" });
    await run({ operation: "claim", number: main });
    const heading = (text: string) =>
      `[...document.querySelectorAll("h2")].some((h) => h.textContent.startsWith(${JSON.stringify(text)}))`;
    await browser("set", "viewport", "1280", "860");
    await browser("open", projectPage);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.body.textContent.includes(${JSON.stringify(doneTitle)})`,
    );
    for (const text of ["进行中", "接下来", "最近完成"]) {
      expect(await evaluate<boolean>(heading(text))).toBe(true);
    }
    // No repository linked: no Code tab.
    const tabs = `[...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent)`;
    expect(await evaluate<string[]>(tabs)).toEqual(["概览", "任务"]);
    await shoot("desktop-overview");

    // The Tasks tab is the Project's board: no Project filter, no Project pill on the cards.
    await browser("open", `${projectPage}?tab=tasks`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.querySelector("[data-task-board]")?.textContent.includes(${JSON.stringify(loneTitle)})`,
    );
    expect(
      await evaluate<boolean>(
        `document.querySelector("[data-task-board]").textContent.includes(${JSON.stringify(home.name)})`,
      ),
    ).toBe(false);
    await shoot("desktop-tasks-tab");
    // A card's title opens its popup over the Project page.
    await evaluate(
      `([...document.querySelectorAll("[data-task-board] a")].find((a) => a.textContent.includes(${JSON.stringify(loneTitle)})).click(), true)`,
    );
    await browser("wait", "--fn", `document.querySelector('[role="dialog"]') !== null`);
    expect(await evaluate<string>("location.pathname")).toEndWith(`/projects/${home.slug}`);
    await shoot("desktop-tasks-popup");

    // On a phone the Tasks tab is the groups, not a board.
    await browser("set", "viewport", "390", "844");
    await browser("open", `${projectPage}?tab=tasks`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.body.textContent.includes(${JSON.stringify(doneTitle)})`,
    );
    expect(await evaluate<boolean>(`document.querySelector("[data-task-board]") === null`)).toBe(
      true,
    );
    expect(await evaluate<boolean>(heading("进行中"))).toBe(true);
    await shoot("phone-tasks-tab");

    // The popup files the lone Task under the other Project, then back under its own.
    await browser("set", "viewport", "1280", "860");
    await browser("open", `${origin}/zh-CN/w/${workspace.slug}/channel/${channel.id}?task=${lone}`);
    const dialog = `document.querySelector('[role="dialog"]')`;
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && ${dialog}?.textContent.includes(${JSON.stringify(loneTitle)}) === true`,
    );
    const trigger = `${dialog}.querySelector('[aria-label^="改项目"]')`;
    await browser("wait", "--fn", `${trigger} !== null`);
    await evaluate(
      `(${trigger}.dispatchEvent(new PointerEvent("pointerenter")), ${trigger}.click(), true)`,
    );
    const option = (text: string) =>
      `[...document.querySelectorAll('[role^="menuitem"], [role="option"]')].find((el) => el.textContent.includes(${JSON.stringify(text)}))`;
    await browser("wait", "--fn", `${option(other.name)} != null`);
    // The Task's own Project holds the check.
    expect(await evaluate<string | null>(`${option(home.name)}.getAttribute("aria-checked")`)).toBe(
      "true",
    );
    await shoot("desktop-project-picker");
    await evaluate(`(${option(other.name)}.click(), true)`);
    await browser("wait", "--fn", `${dialog}.textContent.includes(${JSON.stringify(other.name)})`);
    expect(await projectOf(lone)).toBe(other.slug);
    await evaluate(`(${trigger}.click(), true)`);
    await browser("wait", "--fn", `${option(home.name)} != null`);
    await evaluate(`(${option(home.name)}.click(), true)`);
    await browser("wait", "--fn", `${dialog}.textContent.includes(${JSON.stringify(home.name)})`);
    expect(await projectOf(lone)).toBe(home.slug);
  } finally {
    await browser("close").catch(() => undefined);
    await experiments.write(workspaceId, "taskConversations", before).catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.project
      .deleteMany({ where: { id: { in: [home.id, other.id] } } })
      .catch(() => undefined);
    await db.$disconnect();
  }
}, 240_000);

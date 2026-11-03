import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * A Project's Tasks (task #460): the Project page lists its unfinished Tasks with a sub-task under
 * its main Task, and a Task's popup files it under another Project and back under its channel's.
 * Desktop and phone, light and dark.
 *
 * Opt-in like the other browser E2Es: real local Web started with the `task-conversations` flag
 * file (`/tmp/coforge-flags-tc.json`) and `agent-browser`. Two Projects, a channel
 * in the first and its Tasks are seeded per run and removed after it. Screenshots are written
 * under `.amp/e2e/project-tasks/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/project-tasks");

test("a Project page lists its Tasks as a tree, and a Task's popup moves it between Projects", async () => {
  // Sub-tasks are Tasks v2, behind the task-conversations flag and the Workspace's experiment.
  await installFeatureFlags(
    await readFeatureFlagsConfiguration({
      COFORGE_FEATURE_FLAGS_FILE: "/tmp/coforge-flags-tc.json",
    }),
  );
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
    data: { workspaceId, name: `Launch ${tail}`, slug: `launch-${tail}` },
  });
  const other = await db.project.create({
    data: { workspaceId, name: `Docs ${tail}`, slug: `docs-${tail}` },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-project-${tail}`,
      description: "",
      projectId: home.id,
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
    const main = (await run({ operation: "create", title: mainTitle })).tasks[0]!.number;
    await run({ operation: "create", title: subTitle, parent: { number: main } });
    const lone = (await run({ operation: "create", title: loneTitle })).tasks[0]!.number;
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

    // The popup files the lone Task under the other Project, then under its channel's again.
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
    await shoot("desktop-project-picker");
    await evaluate(`(${option(other.name)}.click(), true)`);
    await browser("wait", "--fn", `${dialog}.textContent.includes(${JSON.stringify(other.name)})`);
    expect(await projectOf(lone)).toBe(other.slug);
    await shoot("desktop-project-set");
    await evaluate(`(${trigger}.click(), true)`);
    await browser("wait", "--fn", `${option("跟随频道的项目")} != null`);
    await evaluate(`(${option("跟随频道的项目")}.click(), true)`);
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

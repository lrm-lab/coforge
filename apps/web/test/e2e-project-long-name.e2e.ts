import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";

/**
 * A very long Project name (task #588) is cut short with an ellipsis wherever it shows: the Task
 * popup's Project property beside its pages and as a chip on a phone, the Workspace board's cards,
 * the Projects list and the Project's own page. Nothing scrolls sideways for it. Desktop and phone,
 * light and dark.
 *
 * Opt-in like the other browser E2Es: real local Web and `agent-browser`. The Project, a channel
 * and a Task are seeded per run and removed after it. Screenshots are written under
 * `.amp/e2e/project-long-name/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/project-long-name");

test("a long Project name truncates in a Task's popup and on its card", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `project-long-name-${process.pid}`);
  const experiments = new PrismaExperimentsRepository(db);
  const board = new TaskBoard(db);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  // As long as the one Frank reported, with no space for a line to break at in its second half.
  const name = `River 2.0 工具型 Agent 的端云协同与离线推理能力建设和全链路评测体系 ${tail}`;
  const project = await db.project.create({
    data: { workspaceId, name, slug: `long-${tail}` },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-long-project-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }] },
    },
  });
  const before = (await experiments.read(workspaceId)).taskConversations;
  try {
    await experiments.write(workspaceId, "taskConversations", true);
    const title = `Benchmark the offline runtime ${tail}`;
    const { number } = (
      await board.execute({ workspaceId, userId: DEV_BROWSER_USER.id }, {
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        operation: "create",
        title,
        project: project.slug,
      } as Parameters<TaskBoard["execute"]>[1])
    ).tasks[0]!;

    await mkdir(artifacts, { recursive: true });
    const shoot = async (shot: string) => {
      await browser(
        "wait",
        "--fn",
        `document.getAnimations().every((a) => a.playState !== "running")`,
      );
      await browser("screenshot", join(artifacts, `${shot}.png`));
      await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
      await browser("screenshot", join(artifacts, `${shot}-dark.png`));
      await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    };
    const dialog = `document.querySelector('[role="dialog"]')`;
    // Each part of the popup that scrolls sideways, and by how much, if any does.
    const sideways = `[...${dialog}.querySelectorAll("*")]
      .filter((el) => /auto|scroll/.test(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1)
      .map((el) => el.tagName + "." + el.className.toString().slice(0, 60) + " +" + (el.scrollWidth - el.clientWidth))`;
    // The name's own text, cut short: its box narrower than what it holds.
    const nameCut = `[...${dialog}.querySelectorAll(".truncate")].some((el) => el.textContent === ${JSON.stringify(name)} && el.scrollWidth > el.clientWidth)`;

    for (const [width, height, label] of [
      [1280, 860, "desktop"],
      [390, 844, "phone"],
    ] as const) {
      await browser("set", "viewport", String(width), String(height));
      await browser(
        "open",
        `${origin}/zh-CN/w/${workspace.slug}/channel/${channel.id}?task=${number}`,
      );
      await browser(
        "wait",
        "--fn",
        `${pageHydrated} && ${dialog}?.textContent.includes(${JSON.stringify(name)}) === true`,
      );
      // The phone's property chips are a row that scrolls by design; everything else must not.
      const scrolling = await evaluate<string[]>(sideways);
      expect(
        scrolling.filter((each) => label === "desktop" || !each.includes("overflow-x-auto")),
      ).toEqual([]);
      expect(await evaluate<boolean>(nameCut)).toBe(true);
      await shoot(`${label}-popup`);
    }

    // Every copy of the name shown on the page is cut short and ends inside the window, and the
    // page does not scroll sideways for it.
    const fits = `(() => {
      const copies = [...document.querySelectorAll("main *")].filter(
        (el) => el.childElementCount === 0 && el.textContent === ${JSON.stringify(name)} && el.getClientRects().length > 0,
      );
      return {
        shown: copies.length,
        inside: copies.every((el) => el.getBoundingClientRect().right <= innerWidth + 1),
        sideways: [...document.querySelectorAll("main, main *")].some(
          (el) => /auto|scroll/.test(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1,
        ),
      };
    })()`;
    const pages = [
      // The Workspace's board names each card's Project (a channel's board leaves it off).
      ["/tasks?layout=board", "tasks-board", title],
      ["/projects", "projects", name],
      [`/projects/${project.slug}`, "project-page", title],
    ] as const;
    for (const [width, height, label] of [
      [1280, 860, "desktop"],
      [390, 844, "phone"],
    ] as const) {
      await browser("set", "viewport", String(width), String(height));
      for (const [path, shot, ready] of pages) {
        // A phone's Tasks page lists rather than boards, and hides a card's Project.
        if (label === "phone" && shot === "tasks-board") continue;
        await browser("open", `${origin}/zh-CN/w/${workspace.slug}${path}`);
        await browser(
          "wait",
          "--fn",
          `${pageHydrated} && document.querySelector("main")?.textContent.includes(${JSON.stringify(ready)}) === true`,
        );
        await shoot(`${label}-${shot}`);
        const result = await evaluate<{ shown: number; inside: boolean; sideways: boolean }>(fits);
        expect({ page: shot, label, ...result }).toEqual({
          page: shot,
          label,
          shown: result.shown,
          inside: true,
          // A board's columns scroll sideways by design; nothing else may.
          sideways: shot === "tasks-board" ? result.sideways : false,
        });
        expect(result.shown).toBeGreaterThan(0);
      }
    }
  } finally {
    await browser("close").catch(() => undefined);
    await experiments.write(workspaceId, "taskConversations", before).catch(() => {});
    await db.task.deleteMany({ where: { conversationId: channel.id } }).catch(() => {});
    await db.conversation.delete({ where: { id: channel.id } }).catch(() => {});
    await db.project.delete({ where: { id: project.id } }).catch(() => {});
    await db.$disconnect();
  }
}, 180_000);

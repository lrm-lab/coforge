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
  animationsSettled,
  pageHydrated,
} from "./helpers/browser-e2e";
import { taskDetail, taskDetailSheetEntered } from "./helpers/task-detail-e2e";

/**
 * A Task's detail sheet on a phone (`TaskDetentSheet`): grab handle, left-aligned channel trail,
 * More/Expand/Close 44px touch controls on the right, uniform chips row with truncating owner, and
 * description at the head of the discussion scroller. Desktop opens an inline split pane and
 * expands to the sidebar properties layout. Screenshots, light and dark, at 390, 320, and 1440
 * wide, are written under `.artifacts/e2e/task-popup-phone-bar/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/task-popup-phone-bar");

type Box = { left: number; right: number; top: number; width: number; height: number };

test("a Task's popup on a phone has a top bar, and its properties are one row of blocks", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `task-phone-bar-${process.pid}`);
  const tail = `${process.pid}-${Date.now()}`;
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `reviewer-${tail}`,
      displayName: "Bartholomew Fitzgerald-Montgomery 审查助手",
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
    },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-phone-bar-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
    },
  });
  const settled = () => browser("wait", "--fn", animationsSettled());
  const shots = async (name: string) => {
    await settled();
    await browser("screenshot", join(artifacts, `${name}.png`));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await settled();
    await browser("screenshot", join(artifacts, `${name}-dark.png`));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  };
  const box = (selector: string) =>
    evaluate<Box | null>(
      `(() => { const el = ${selector}; if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height }; })()`,
    );
  const dialog = taskDetail;
  const close = `${dialog}.querySelector('button[aria-label="Close"]')`;
  const more = `${dialog}.querySelector('button[aria-label^="More actions"]')`;
  const expand = `${dialog}.querySelector('button[aria-label="Expand"]')`;
  const collapse = `${dialog}.querySelector('button[aria-label="Collapse"]')`;
  const place = `${dialog}.querySelector('nav[aria-label="Where this task is"] > span:last-child')`;
  const titleIcon = `${dialog}.querySelector('h2 svg')`;
  const chips = `[...${dialog}.querySelectorAll('dl[data-layout="chips"] > div')]`;
  const ownerName = `${dialog}.querySelector('dl[data-layout="chips"] span.break-words')`;
  const discussion = `${dialog}.querySelector('[data-scroll-restoration-id^="conversation-"]')`;
  const description = `[...${dialog}.querySelectorAll("*")].filter((el) => el.textContent.includes("Seen on Safari and Chrome.")).at(-1)`;
  const inDiscussion = `${discussion}.contains(${description})`;
  try {
    const { tasks } = await new TaskBoard(db).execute(
      { workspaceId, userId: DEV_BROWSER_USER.id },
      {
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        operation: "create",
        title: `Unify the push notification copy on iOS and Android and check the icons ${tail}`,
        description:
          "The login page flickers white for a moment on a slow connection before the form shows. Seen on Safari and Chrome.",
      } as Parameters<TaskBoard["execute"]>[1],
    );
    const number = tasks[0]!.number;
    const owner = await db.conversationMember.findFirstOrThrow({
      where: { conversationId: channel.id, agentId: agent.id },
    });
    await db.task.updateMany({
      where: { conversationId: channel.id, number },
      data: { status: "in_progress", priority: "urgent", ownerMemberId: owner.id },
    });
    await mkdir(artifacts, { recursive: true });
    const open = async (width: string, height: string) => {
      await browser("set", "viewport", width, height);
      await browser(
        "open",
        `${origin}/en/w/${workspace.slug}/channel/${channel.id}?task=${number}`,
      );
      await browser(
        "wait",
        "--fn",
        `${pageHydrated} && ${dialog}?.querySelector('nav[aria-label="Where this task is"] .avatar-group') != null`,
      );
      await browser("wait", "--fn", `${taskDetailSheetEntered} && ${animationsSettled()}`);
    };

    for (const [width, height] of [
      ["390", "844"],
      ["320", "640"],
    ] as const) {
      await open(width, height);
      const viewport = Number(width);
      expect(
        await evaluate<string | null>(
          `document.querySelector('[data-detent-sheet]')?.getAttribute("data-detent") ?? null`,
        ),
      ).toBe("half");
      expect(
        await evaluate<boolean>(
          `document.querySelector('[data-detent-grab]')?.checkVisibility() ?? false`,
        ),
      ).toBe(true);

      const closeBox = (await box(close))!;
      const moreBox = (await box(more))!;
      const expandBox = (await box(expand))!;
      const placeBox = (await box(place))!;
      expect(placeBox.left).toBeGreaterThanOrEqual(0);
      expect(placeBox.right).toBeLessThanOrEqual(moreBox.left);
      expect(moreBox.right).toBeLessThanOrEqual(expandBox.left);
      expect(expandBox.right).toBeLessThanOrEqual(closeBox.left);
      expect(closeBox.right).toBeLessThanOrEqual(viewport);
      for (const button of [moreBox, expandBox, closeBox]) {
        expect(Math.round(button.width)).toBe(44);
        expect(Math.round(button.height)).toBe(44);
      }
      expect(await evaluate<string>(`${place}.textContent`)).toBe(
        `e2e-phone-bar-${tail}#${number}`,
      );
      expect(await evaluate<boolean>(`${titleIcon}?.checkVisibility() ?? false`)).toBe(false);
      const heights = await evaluate<number[]>(
        `${chips}.filter((el) => el.checkVisibility()).map((el) => Math.round(el.getBoundingClientRect().height))`,
      );
      expect(new Set(heights).size).toBe(1);
      expect(await evaluate<boolean>(`${ownerName}.scrollWidth > ${ownerName}.clientWidth`)).toBe(
        true,
      );
      expect(await evaluate<boolean>(inDiscussion)).toBe(true);
      const lines = await evaluate<number>(`(() => {
        const range = document.createRange();
        range.selectNodeContents(${description});
        return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
      })()`);
      expect(lines).toBeGreaterThan(2);
      await shots(`phone-${width}`);

      await evaluate(`(${expand}.setAttribute("data-e2e-sheet-expand", ""), true)`);
      await browser("click", "[data-e2e-sheet-expand]");
      await browser(
        "wait",
        "--fn",
        `document.querySelector('[data-detent-sheet]')?.getAttribute("data-detent") === "full" && ${collapse} != null`,
      );
    }

    await open("1440", "900");
    expect((await box(close))!.left).toBeGreaterThan((await box(more))!.right);
    expect(await evaluate<boolean>(`${titleIcon} === null`)).toBe(true);
    expect(
      await evaluate<number>(`${dialog}.getBoundingClientRect().height`),
    ).toBeGreaterThanOrEqual(700);
    expect(await evaluate<number>(`${discussion}.getBoundingClientRect().height`)).toBeGreaterThan(
      256,
    );
    expect(await evaluate<boolean>(inDiscussion)).toBe(true);

    await evaluate(`(${expand}.setAttribute("data-e2e-panel-expand", ""), true)`);
    await browser("click", "[data-e2e-panel-expand]");
    await browser(
      "wait",
      "--fn",
      `${dialog}?.querySelector('aside dl[data-layout="sidebar"]') !== null`,
    );
    await shots("desktop");
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);

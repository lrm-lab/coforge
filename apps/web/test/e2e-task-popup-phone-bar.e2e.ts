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
 * A Task's popup on a phone is a page with a top bar (task #70): close on the left, the channel's
 * group avatar, name and the Task's number centred, More on the right, each 44px to touch. The
 * title does not repeat the status the first chip shows, and the chips are one row of blocks, as
 * in New task (task #54), a long owner's name truncating in its block rather than wrapping. A
 * desktop keeps close on the right and the status before the title. Screenshots, light and dark,
 * at 390 and 320 wide, are written under `.amp/e2e/task-popup-phone-bar/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/task-popup-phone-bar");

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
  const box = (selector: string) =>
    evaluate<Box | null>(
      `(() => { const el = ${selector}; if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height }; })()`,
    );
  const dialog = `document.querySelector('[role="dialog"]')`;
  const close = `${dialog}.querySelector('button[aria-label="Close"]')`;
  const more = `${dialog}.querySelector('button[aria-label^="More actions"]')`;
  const place = `${dialog}.querySelector('nav[aria-label="Where this task is"] > span:last-child')`;
  const titleIcon = `${dialog}.querySelector('h2 svg')`;
  const chips = `[...${dialog}.querySelectorAll('dl[data-layout="chips"] > div')]`;
  const ownerName = `${dialog}.querySelector('dl[data-layout="chips"] span.break-words')`;
  try {
    const { tasks } = await new TaskBoard(db).execute(
      { workspaceId, userId: DEV_BROWSER_USER.id },
      {
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        operation: "create",
        title: `Unify the push notification copy on iOS and Android and check the icons ${tail}`,
      } as Parameters<TaskBoard["execute"]>[1],
    );
    const number = tasks[0]!.number;
    const owner = await db.conversationMember.findFirstOrThrow({
      where: { conversationId: channel.id, agentId: agent.id },
    });
    await db.task.updateMany({
      where: { conversationId: channel.id, number },
      data: { status: "in_review", priority: "urgent", ownerMemberId: owner.id },
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
      await settled();
    };

    for (const [width, height] of [
      ["390", "844"],
      ["320", "640"],
    ] as const) {
      await open(width, height);
      const viewport = Number(width);
      const closeBox = (await box(close))!;
      const moreBox = (await box(more))!;
      const placeBox = (await box(place))!;
      // Close at the left edge, More at the right, each 44px square.
      expect(closeBox.right).toBeLessThanOrEqual(placeBox.left);
      expect(moreBox.left).toBeGreaterThanOrEqual(placeBox.right);
      expect(Math.round(closeBox.left)).toBe(0);
      expect(Math.round(moreBox.right)).toBe(viewport);
      for (const button of [closeBox, moreBox]) {
        expect(Math.round(button.width)).toBe(44);
        expect(Math.round(button.height)).toBe(44);
      }
      // The place is centred on the page, and reads the channel's name with no `#`.
      expect(Math.abs(placeBox.left + placeBox.width / 2 - viewport / 2)).toBeLessThan(2);
      expect(await evaluate<string>(`${place}.textContent`)).toBe(
        `e2e-phone-bar-${tail}#${number}`,
      );
      // The title does not repeat the status; the first chip says it.
      expect(await evaluate<boolean>(`${titleIcon}.checkVisibility()`)).toBe(false);
      // One row of blocks of one height: the long owner's name truncates rather than wrapping.
      const heights = await evaluate<number[]>(
        `${chips}.filter((el) => el.checkVisibility()).map((el) => Math.round(el.getBoundingClientRect().height))`,
      );
      expect(new Set(heights).size).toBe(1);
      expect(await evaluate<boolean>(`${ownerName}.scrollWidth > ${ownerName}.clientWidth`)).toBe(
        true,
      );
      await shots(`phone-${width}`);
    }

    // A desktop keeps its bar: close on the right after More, the status before the title.
    await open("1440", "900");
    expect((await box(close))!.left).toBeGreaterThan((await box(more))!.right);
    expect(await evaluate<boolean>(`${titleIcon}.checkVisibility()`)).toBe(true);
    await shots("desktop");
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);

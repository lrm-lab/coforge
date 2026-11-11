import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * A phone's task list row (task #14): the title takes the row's width and wraps to two lines, the
 * number and channel sit under it, and there is no drag handle (the menu moves a task). From `sm`
 * up the row stays one line with its handle. Screenshots go under `.amp/e2e/phone-task-row/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/phone-task-row");

test("a phone's task row gives the title the width, two lines, and no drag handle", async () => {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  const { browser, evaluate } = browserSession(browserPath, `phone-task-row-${process.pid}`);
  const tail = `${process.pid}-${Date.now()}`;
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  // Long enough that, uncut, it would push the row's second line past the owner and menu at 320.
  const channelName = `e2e-row-onboarding-and-first-week-${tail}`;
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName,
      description: "",
      members: { create: { userId: DEV_BROWSER_USER.id } },
    },
  });
  const title = `Rewrite the onboarding checklist so a new member can finish setup without asking anyone ${tail}`;
  try {
    const { tasks } = await new TaskBoard(db).execute(
      { workspaceId, userId: DEV_BROWSER_USER.id },
      {
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        operation: "create",
        title,
      } as Parameters<TaskBoard["execute"]>[1],
    );
    const number = tasks[0]!.number;
    await mkdir(artifacts, { recursive: true });

    // The row's geometry, read off the article that holds the title.
    const measure = () =>
      evaluate<{
        rowWidth: number;
        titleWidth: number;
        lines: number;
        handle: boolean;
        second: string | null;
        overflow: boolean;
      }>(`(() => {
          const h3 = [...document.querySelectorAll("article h3")].find((el) => el.textContent.includes(${JSON.stringify(tail)}));
          const article = h3.closest("article");
          const row = article.getBoundingClientRect();
          const box = h3.getBoundingClientRect();
          const line = parseFloat(getComputedStyle(h3).lineHeight);
          const handle = article.querySelector('[aria-label="Move task #${number}"]');
          const second = h3.nextElementSibling;
          return {
            rowWidth: row.width,
            titleWidth: box.width,
            lines: Math.round(box.height / line),
            handle: handle != null && handle.getClientRects().length > 0,
            second: second && second.getClientRects().length > 0 ? second.textContent : null,
            overflow: second != null && second.scrollWidth > second.clientWidth,
          };
        })()`);

    const open = async (width: string, height: string) => {
      await browser("set", "viewport", width, height);
      await browser("open", `${origin}/en/w/${workspace.slug}/tasks?layout=list`);
      await browser(
        "wait",
        "--fn",
        `${pageHydrated} && [...document.querySelectorAll("article h3")].some((el) => el.textContent.includes(${JSON.stringify(tail)}))`,
      );
    };

    for (const width of ["390", "320"]) {
      await open(width, "844");
      const row = await measure();
      // Beside the title stand only the status icon, the owner and the menu (136px with the gaps
      // and padding); the number column, priority slot and drag handle cost another 110.
      expect(row.titleWidth).toBeGreaterThan(row.rowWidth - 150);
      expect(row.lines).toBe(2);
      expect(row.handle).toBe(false);
      // The number and the channel sit under the title: `#name` until the channel's members load,
      // then their avatars and the bare name.
      expect(row.second).toContain(`#${number}`);
      await browser(
        "wait",
        "--fn",
        `[...document.querySelectorAll("article h3")].find((el) => el.textContent.includes(${JSON.stringify(tail)}))?.nextElementSibling?.querySelector(".avatar-group-xs") != null`,
      );
      const { second, overflow } = await measure();
      expect(second).toContain(channelName);
      expect(second).not.toContain(`#${channelName}`);
      expect(overflow).toBe(false);
      await browser("screenshot", join(artifacts, `phone-${width}.png`));
    }

    await open("1440", "900");
    const desktop = await measure();
    expect(desktop.lines).toBe(1);
    expect(desktop.handle).toBe(true);
    expect(desktop.second).toBeNull();
    await browser("screenshot", join(artifacts, "desktop.png"));
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);

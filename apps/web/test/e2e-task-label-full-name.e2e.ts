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
 * A Task popup writes each label's whole name (task #coforge-designer-team:#7): its label menu
 * does not repeat the label, so the popup is the one place a long name shows in full. Seeds a
 * channel, a Task and two labels as long as a name may be (32), and removes them after the run.
 * Screenshots, desktop and phone, light and dark, are under `.amp/e2e/task-label-full-name/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/task-label-full-name");

test("a Task popup shows a long label name whole", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `label-full-${process.pid}`);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const tail = `${process.pid}${Date.now()}`.slice(-5);
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-label-full-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }] },
    },
  });
  // 32 characters each, the most a label name may be (`LABEL_NAME_MAX`).
  const names = [
    `Customer escalation · Northw${tail}`.slice(0, 32),
    `客户升级与跨部门协调专项工作组临时标签${tail}`,
  ];
  const labels: string[] = [];
  try {
    const created = await new TaskBoard(db).execute({ workspaceId, userId: DEV_BROWSER_USER.id }, {
      idempotencyKey: crypto.randomUUID(),
      conversationId: channel.id,
      operation: "create",
      titles: [`Label me ${tail}`],
    } as Parameters<TaskBoard["execute"]>[1]);
    const number = created.tasks[0]!.number;
    const task = await db.task.findFirstOrThrow({ where: { conversationId: channel.id, number } });
    for (const name of names) {
      const label = await db.label.create({
        data: { workspaceId, name, nameKey: name.trim().toLowerCase(), color: "purple" },
      });
      labels.push(label.id);
      await db.taskLabel.create({ data: { taskId: task.id, labelId: label.id } });
    }

    const whole = (name: string) =>
      `(() => { const el = [...document.querySelectorAll('[role="dialog"] span')].find((s) => s.textContent === ${JSON.stringify(name)}); return el != null && el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= innerWidth; })()`;
    await mkdir(artifacts, { recursive: true });
    for (const [width, height, device] of [
      [1440, 900, "desktop"],
      [390, 844, "phone"],
    ] as const) {
      await browser("set", "viewport", String(width), String(height));
      await browser(
        "open",
        `${origin}/en/w/${workspace.slug}/channel/${channel.id}?task=${number}`,
      );
      const shown = names
        .map(
          (name) =>
            `document.querySelector('[role="dialog"]')?.textContent.includes(${JSON.stringify(name)})`,
        )
        .join(" && ");
      await browser("wait", "--fn", `${pageHydrated} && ${shown}`);
      await browser("wait", "500");
      // A phone's chip row scrolls sideways: bring each label into view before measuring it.
      for (const name of names) {
        await evaluate(
          `([...document.querySelectorAll('[role="dialog"] span')].find((s) => s.textContent === ${JSON.stringify(name)}).scrollIntoView({ inline: "nearest", block: "nearest" }), true)`,
        );
        expect(await evaluate<boolean>(whole(name))).toBe(true);
      }
      await browser("screenshot", join(artifacts, `${device}.png`));
      await evaluate(`(document.documentElement.classList.add("dark-mode"), true)`);
      await browser("wait", "300");
      await browser("screenshot", join(artifacts, `${device}-dark.png`));
      await evaluate(`(document.documentElement.classList.remove("dark-mode"), true)`);
    }
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.label.deleteMany({ where: { id: { in: labels } } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);

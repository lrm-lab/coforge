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
 * A finished Task's owner menu does not offer "Unassigned": the server refuses to leave a Done
 * Task with no one (task #709), so the option would only fail. A Task still to do keeps it.
 * Seeds a channel, an Agent and two Tasks, removed after the run. Screenshots, light and phone,
 * are under `.amp/e2e/task-done-owner-menu/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/task-done-owner-menu");

test("a Done Task's owner menu has no Unassigned", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `done-owner-${process.pid}`);
  const experiments = new PrismaExperimentsRepository(db);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const before = (await experiments.read(workspaceId)).taskConversations;
  const tail = `${process.pid}-${Date.now()}`.slice(-5);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-done-owner-${tail}`,
      displayName: `Done Owner Agent ${tail}`,
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
      channelName: `e2e-done-owner-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
    },
  });
  try {
    await experiments.write(workspaceId, "taskConversations", true);
    const board = new TaskBoard(db);
    const run = (command: Record<string, unknown>) =>
      board.execute({ workspaceId, userId: DEV_BROWSER_USER.id }, {
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        ...command,
      } as Parameters<TaskBoard["execute"]>[1]);
    const open = (await run({ operation: "create", titles: [`Still to do ${tail}`] })).tasks[0]!
      .number;
    const finished = (await run({ operation: "create", titles: [`Already done ${tail}`] }))
      .tasks[0]!.number;
    for (const number of [open, finished])
      await run({ operation: "assign", number, assignee: `@${agent.name}` });
    await run({ operation: "update", number: finished, status: "done" });

    await mkdir(artifacts, { recursive: true });
    const owner = `document.querySelector('button[aria-label^="Change owner"]')`;
    const options = `[...document.querySelectorAll('[role="menuitemradio"]')].map((o) => o.textContent.trim())`;
    async function menuOptions(number: number, shot?: string) {
      await browser(
        "open",
        `${origin}/en/w/${workspace.slug}/channel/${channel.id}?task=${number}`,
      );
      await browser("wait", "--fn", `${pageHydrated} && ${owner} != null`);
      await browser("eval", `${owner}.click()`);
      await browser("wait", "--fn", `${options}.length > 0`);
      // The popup and the menu finish opening before the picture, or the page shows through.
      await browser("wait", "800");
      if (shot) await browser("screenshot", join(artifacts, `${shot}.png`));
      return evaluate<string[]>(options);
    }
    await browser("set", "viewport", "1440", "900");
    // "Unassigned" heads a Task still to do's list, as "No assignee" does in Linear.
    expect((await menuOptions(open, "desktop-todo"))[0]).toBe("Unassigned");
    const done = await menuOptions(finished, "desktop");
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await browser("wait", "300");
    await browser("screenshot", join(artifacts, "desktop-dark.png"));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    // Esc from the empty search field closes the picker.
    await browser("press", "Escape");
    await browser("wait", "--fn", `${options}.length === 0`);
    expect(done.length).toBeGreaterThan(0);
    expect(done).not.toContain("Unassigned");
    await browser("set", "viewport", "820", "1180");
    expect(await menuOptions(finished, "tablet")).not.toContain("Unassigned");
    await browser("set", "viewport", "390", "844");
    expect((await menuOptions(open, "phone-todo"))[0]).toBe("Unassigned");
    expect(await menuOptions(finished, "phone")).not.toContain("Unassigned");
  } finally {
    await experiments.write(workspaceId, "taskConversations", before === true).catch(() => {});
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);

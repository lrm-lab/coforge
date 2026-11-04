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
 * Deleting a Task from its popup offers Undo for a short while (Frank, 11-04, task #507): a toast
 * says which Task went, and Undo brings it back on the server and on the page. Opt-in like the
 * other browser E2Es; the channel and Task are seeded per run and removed after it. Screenshots go
 * under `.amp/e2e/task-delete-undo/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/task-delete-undo");

test("a Task deleted from its popup comes back with Undo", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `task-delete-undo-${process.pid}`);
  const experiments = new PrismaExperimentsRepository(db);
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const before = (await experiments.read(workspaceId)).taskConversations;
  const tail = `${process.pid}-${Date.now()}`.slice(-5);
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-task-undo-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }] },
    },
  });
  try {
    await experiments.write(workspaceId, "taskConversations", true);
    const title = `Check the sign-up flow ${tail}`;
    const created = await new TaskBoard(db).execute({ workspaceId, userId: DEV_BROWSER_USER.id }, {
      idempotencyKey: crypto.randomUUID(),
      conversationId: channel.id,
      operation: "create",
      titles: [title],
    } as Parameters<TaskBoard["execute"]>[1]);
    const number = created.tasks[0]!.number;
    const deletedAt = async () =>
      (await db.task.findFirstOrThrow({ where: { conversationId: channel.id, number } })).deletedAt;

    await mkdir(artifacts, { recursive: true });
    const toast = `[...document.querySelectorAll("[data-sonner-toast]")].find((el) => el.textContent.includes("Deleted Task #${number}"))`;
    const shoot = async (name: string) => {
      await browser("screenshot", join(artifacts, `${name}.png`));
      await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
      await browser("wait", "300");
      await browser("screenshot", join(artifacts, `${name}-dark.png`));
      await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    };
    const deleteFromPopup = async (confirmShot?: string) => {
      await browser(
        "open",
        `${origin}/en/w/${workspace.slug}/channel/${channel.id}?task=${number}`,
      );
      await browser(
        "wait",
        "--fn",
        `${pageHydrated} && document.querySelector('[role="dialog"] button[aria-label="More Actions for Task #${number}"]') != null`,
      );
      await browser(
        "click",
        `[role="dialog"] button[aria-label="More Actions for Task #${number}"]`,
      );
      await browser(
        "wait",
        "--fn",
        `document.querySelector('[role="menuitem"][data-key="delete"]') != null`,
      );
      await browser("click", `[role="menuitem"][data-key="delete"]`);
      const confirm = `[...document.querySelectorAll('[role="alertdialog"], [role="dialog"]')].find((el) => el.textContent.includes("Delete Task #${number}?"))`;
      await browser("wait", "--fn", `${confirm} != null`);
      if (confirmShot) await shoot(confirmShot);
      await evaluate(
        `([...${confirm}.querySelectorAll("button")].find((el) => el.textContent.trim() === "Delete Task").setAttribute("data-e2e-confirm", ""), true)`,
      );
      await browser("click", "[data-e2e-confirm]");
      await browser("wait", "--fn", `${toast} != null`);
    };

    await browser("set", "viewport", "1280", "900");
    await deleteFromPopup("confirm");
    expect(await deletedAt()).not.toBeNull();
    expect(await evaluate<boolean>(`${toast}.textContent.includes("Undo")`)).toBe(true);
    await shoot("deleted");

    // Undo: the Task is back, on the server and on the page.
    await evaluate(
      `([...${toast}.querySelectorAll("button")].find((el) => el.textContent.trim() === "Undo").setAttribute("data-e2e-undo", ""), true)`,
    );
    await browser("click", "[data-e2e-undo]");
    for (let tries = 0; tries < 50 && (await deletedAt()) !== null; tries++)
      await browser("wait", "100");
    expect(await deletedAt()).toBeNull();
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}?task=${number}`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && [...document.querySelectorAll('[role="dialog"]')].some((el) => el.textContent.includes(${JSON.stringify(title)}))`,
    );

    // On a phone the same toast.
    await browser("set", "viewport", "390", "844");
    await deleteFromPopup();
    await shoot("deleted-phone");
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await experiments.write(workspaceId, "taskConversations", before).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);

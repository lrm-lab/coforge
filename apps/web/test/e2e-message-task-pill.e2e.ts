import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { Labels } from "#src/server/tasks/labels.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * The pill under a message made into a Task (task #449, plan A v2): its status, number and owner
 * always; "Waiting on #N" while a blocker is open and its sub-tasks' progress, each only when
 * there is one. Desktop and phone, light and dark. Opt-in like the other browser E2Es; the
 * channel is seeded per run and removed after it, and the Workspace's Tasks v2 switch is put
 * back. Screenshots go under `.amp/e2e/message-task-pill/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/message-task-pill");

test("a message's Task shows as the chip its words name Tasks with, its details in the peek", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `message-task-pill-${process.pid}`);
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
      channelName: `e2e-task-pill-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }] },
    },
  });
  const me = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: channel.id, userId: DEV_BROWSER_USER.id },
  });
  const board = new TaskBoard(db);
  const run = (command: Record<string, unknown>) =>
    board.execute({ workspaceId, userId: DEV_BROWSER_USER.id }, {
      idempotencyKey: crypto.randomUUID(),
      conversationId: channel.id,
      ...command,
    } as Parameters<TaskBoard["execute"]>[1]);
  try {
    await experiments.write(workspaceId, "taskConversations", true);
    const message = await db.message.create({
      data: {
        workspaceId,
        conversationId: channel.id,
        sequence: 1,
        senderMemberId: me.id,
        body: `Ship the home page skeleton under 3 seconds ${tail}`,
      },
    });
    const blocker = (
      await run({ operation: "create", title: `API returns first-screen data ${tail}` })
    ).tasks[0]!.number;
    const labels = new Labels(db);
    await labels.create(workspaceId, DEV_BROWSER_USER.id, {
      name: `Frontend ${tail}`,
      color: "blue",
    });
    const task = (
      await run({
        operation: "create",
        title: `Ship the home page skeleton under 3 seconds ${tail}`,
        messageId: message.id,
        labels: [`Frontend ${tail}`],
        priority: "high",
      })
    ).tasks[0]!.number;
    await run({ operation: "amend", number: task, blockedBy: [{ number: blocker }] });
    await run({ operation: "assign", number: task, assignee: `@${DEV_BROWSER_USER.username}` });
    const subtasks = (
      await run({
        operation: "create",
        titles: [`Skeleton markup ${tail}`, `Lazy-load the hero ${tail}`],
        parent: { number: task },
      })
    ).tasks.map((each) => each.number);
    await run({ operation: "claim", numbers: [subtasks[0]] }).catch(() => undefined);
    await run({ operation: "move", number: subtasks[0], status: "done" }).catch(() => undefined);
    // A reply that names several Tasks in its words, as an Agent's often does (Frank, 11-04): the
    // screenshot shows the two kinds side by side.
    await db.message.create({
      data: {
        workspaceId,
        conversationId: channel.id,
        sequence: 2,
        senderMemberId: me.id,
        body: `Split it up: <@task:${blocker}> first, then <@task:${subtasks[0]}> and <@task:${subtasks[1]}>.`,
      },
    });

    const pill = `document.querySelector('[data-message-task="${task}"]')`;
    const text = `(${pill}?.textContent ?? "")`;
    const shoot = async (shot: string) => {
      await browser("wait", "500");
      await browser("screenshot", join(artifacts, `${shot}.png`));
      await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
      await browser("wait", "300");
      await browser("screenshot", join(artifacts, `${shot}-dark.png`));
      await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    };
    await mkdir(artifacts, { recursive: true });
    const page = `${origin}/en/w/${workspace.slug}/channel/${channel.id}?view=chat`;
    for (const [shot, width, height] of [
      ["desktop", "1280", "720"],
      ["phone", "390", "844"],
    ] as const) {
      await browser("set", "viewport", width, height);
      await browser("open", page);
      await browser("wait", "--fn", `${pageHydrated} && ${pill} !== null`);
      // The same chip a message's words name a Task with (Frank, 11-04): its status icon and its
      // title, and nothing else on the line.
      await browser("wait", "--fn", `${text}.includes("Ship the home page")`);
      const shown = await evaluate<string>(text);
      expect(shown).not.toContain(DEV_BROWSER_USER.name);
      expect(shown).not.toContain(`#${task}`);
      expect(
        await evaluate<string | null>(
          `${pill}?.querySelector("[data-task-status]")?.getAttribute("data-task-status") ?? null`,
        ),
      ).toBe("todo");
      // The reply's own Task references read as chips with their titles.
      await browser(
        "wait",
        "--fn",
        `(document.body.textContent ?? "").includes(${JSON.stringify(`Skeleton markup ${tail}`)})`,
      );
      // The size of the chips in the message's words (Settings → Message font size).
      expect(
        await evaluate<string>(
          `JSON.stringify([...document.querySelectorAll("[data-task-status]")].map((el) => getComputedStyle(el).fontSize).filter((size, index, all) => all.indexOf(size) === index))`,
        ),
      ).toBe('["14px"]');
      await shoot(shot);
      if (shot === "desktop") {
        // The details are in the peek a hover opens: its number on top, who holds it, its priority
        // and its labels.
        // A pointer that has not moved since the page opened makes no hover; move it in first.
        await browser("mouse", "move", "10", "10");
        await browser("hover", `[data-message-task="${task}"] [data-task-status]`);
        // The peek opens with the Task's number, its only line that reads "#N" alone.
        const peek = `([...document.querySelectorAll("p")].find((el) => el.textContent === "#${task}")?.parentElement?.textContent ?? "")`;
        await browser("wait", "--fn", `${peek}.includes(${JSON.stringify(`Frontend ${tail}`)})`);
        const details = await evaluate<string>(peek);
        expect(details).toContain(DEV_BROWSER_USER.name);
        expect(details).toContain("High");
        // What it waits on and its sub-tasks stay on its card and popup (Frank, 11-04).
        expect(details).not.toContain("API returns first-screen data");
        expect(details).toContain(`#${task}`);
        expect(details).toContain(`Frontend ${tail}`);
        await shoot("desktop-peek");
      }
    }
  } finally {
    await experiments
      .write(workspaceId, "taskConversations", before === true)
      .catch(() => undefined);
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.label
      .deleteMany({ where: { workspaceId, name: { endsWith: tail } } })
      .catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);

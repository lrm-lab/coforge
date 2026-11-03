import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { Labels } from "#src/server/tasks/labels.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * Task labels, the simple version (task #455): the Task popup's picker ticks the Workspace's labels
 * on and off and makes a new one from its name, with a color of its own; a card shows its labels;
 * a board keeps the Tasks with a picked label, or with none. Desktop and phone.
 *
 * Opt-in like the other browser E2Es: real local Web and `agent-browser`. The channel, its Tasks
 * and the run's labels are seeded per run and removed after it. Screenshots are written under
 * `.amp/e2e/task-labels-picker/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/task-labels-picker");

test("labels go on and off a Task, are made from a name, show on cards and filter a board", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `task-labels-${process.pid}`);
  const board = new TaskBoard(db);
  const labels = new Labels(db);
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const tail = `${process.pid}-${Date.now()}`.slice(-5);
  const name = (label: string) => `${label}${tail}`;
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-labels-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }] },
    },
  });
  try {
    const as = DEV_BROWSER_USER.id;
    const bug = await labels.create(workspaceId, as, { name: name("Bug"), color: "error" });
    await labels.create(workspaceId, as, { name: name("Design"), color: "pink" });
    const run = (command: Record<string, unknown>) =>
      board.execute({ workspaceId, userId: as }, {
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        ...command,
      } as Parameters<TaskBoard["execute"]>[1]);
    const labelled = `Label me ${tail}`;
    const bare = `Leave me ${tail}`;
    const number = (await run({ operation: "create", title: labelled, labels: [name("Bug")] }))
      .tasks[0]!.number;
    await run({ operation: "create", title: bare });
    const onTask = async () =>
      (
        await db.task.findFirstOrThrow({
          where: { conversationId: channel.id, number },
          select: { labels: { select: { label: { select: { name: true } } } } },
        })
      ).labels
        .map((row) => row.label.name)
        .sort();

    const dialog = `document.querySelector('[role="dialog"]')`;
    const settled = () =>
      browser("wait", "--fn", `document.getAnimations().every((a) => a.playState !== "running")`);
    const menu = `document.querySelector('[role="menu"][aria-label="Labels"]')`;
    const item = (label: string) =>
      `[...(${menu}?.querySelectorAll('[role^="menuitem"]') ?? [])].find((el) => el.textContent.includes(${JSON.stringify(label)}))`;
    const props = `[...${dialog}.querySelectorAll("dl")].map((el) => el.textContent).join(" ")`;
    const openPicker = async () => {
      await evaluate(`(${dialog}.querySelector('[aria-label="Edit labels"]').click(), true)`);
      await browser("wait", "--fn", `${menu} !== null`);
      await settled();
    };
    const shoot = async (shot: string) => {
      await settled();
      await browser("screenshot", join(artifacts, `${shot}.png`));
      await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
      await browser("screenshot", join(artifacts, `${shot}-dark.png`));
      await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    };
    await mkdir(artifacts, { recursive: true });
    const popup = `${origin}/en/w/${workspace.slug}/channel/${channel.id}?task=${number}`;

    await browser("set", "viewport", "1280", "860");
    await browser("open", popup);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && ${dialog}?.textContent.includes(${JSON.stringify(labelled)}) === true`,
    );
    await openPicker();
    // One flat list: no group headings, every label a checkbox, the Task's own ticked.
    expect(await evaluate<string | null>(`${item(name("Bug"))}.getAttribute("aria-checked")`)).toBe(
      "true",
    );
    expect(await evaluate<number>(`${menu}.querySelectorAll("header").length`)).toBe(0);
    await shoot("desktop-1-picker");
    // Esc closes the picker and keeps the Task's labels (React Aria's menus clear their picks on
    // Esc instead, and stay open).
    await browser("press", "Escape");
    await browser("wait", "--fn", `${menu} === null`);
    expect(await onTask()).toEqual([name("Bug")]);
    await openPicker();
    await evaluate(`(${item(name("Design"))}.click(), true)`);
    await browser("wait", "--fn", `${props}.includes(${JSON.stringify(name("Design"))})`);
    expect(await onTask()).toEqual([name("Bug"), name("Design")].sort());
    // A name no label has: created on the spot, in a color that is not gray, and put on.
    await openPicker();
    await browser(
      "fill",
      '[role="dialog"] input[aria-label="Add or create a label…"]',
      name("Motion"),
    );
    const create = `[...document.querySelectorAll("button")].find((b) => b.textContent.includes(${JSON.stringify(`Create label “${name("Motion")}”`)}))`;
    await browser("wait", "--fn", `${create} != null`);
    await shoot("desktop-2-create");
    await evaluate(`(${create}.click(), true)`);
    await browser("wait", "--fn", `${props}.includes(${JSON.stringify(name("Motion"))})`);
    expect(await onTask()).toEqual([name("Bug"), name("Design"), name("Motion")].sort());
    const motion = await db.label.findFirstOrThrow({
      where: { workspaceId, name: name("Motion") },
      select: { color: true },
    });
    expect(motion.color).not.toBe("gray");
    await browser("press", "Escape");
    await browser("wait", "--fn", `${menu} === null`);
    // History names each label and priority change, instead of leaving an empty row.
    await run({ operation: "update", number, priority: "high" });
    const history = `[...${dialog}.querySelectorAll('[role="tab"]')].find((el) => el.textContent.includes("History"))`;
    await evaluate(`(${history}.click(), true)`);
    const inPopup = (text: string) => `${dialog}.textContent.includes(${JSON.stringify(text)})`;
    await browser("wait", "--fn", `${inPopup("Changed labels")} && ${inPopup("Changed priority")}`);
    expect(await evaluate<boolean>(inPopup(`Added: ${name("Motion")}`))).toBe(true);
    expect(await evaluate<boolean>(inPopup("Priority: None → High"))).toBe(true);
    await shoot("desktop-2b-history");
    await browser("press", "Escape");

    // The board: the card shows its labels; a label pick keeps the Tasks that carry it, and
    // "No label" the ones with none.
    const tasksPage = (labelPick: string) =>
      `${origin}/en/w/${workspace.slug}/channel/${channel.id}?view=tasks&labels=${labelPick}`;
    const shows = (title: string) =>
      `(document.querySelector("[data-task-board]")?.textContent ?? "").includes(${JSON.stringify(title)})`;
    const chips = (text: string) => `document.body.textContent.includes(${JSON.stringify(text)})`;
    await browser("open", tasksPage(bug.id));
    await browser("wait", "--fn", `${pageHydrated} && ${shows(labelled)}`);
    expect(await evaluate<boolean>(shows(bare))).toBe(false);
    expect(await evaluate<boolean>(chips("Labels include"))).toBe(true);
    await shoot("desktop-3-board-filter");
    await browser("open", tasksPage("none"));
    await browser("wait", "--fn", `${pageHydrated} && ${shows(bare)}`);
    expect(await evaluate<boolean>(shows(labelled))).toBe(false);

    await browser("set", "viewport", "390", "844");
    await browser("open", popup);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && ${dialog}?.textContent.includes(${JSON.stringify(labelled)}) === true`,
    );
    await openPicker();
    await shoot("phone-1-picker");
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.label
      .deleteMany({ where: { workspaceId, name: { endsWith: tail } } })
      .catch(() => undefined);
    await db.$disconnect();
  }
}, 240_000);

import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { LABEL_PALETTE, newLabelColor } from "#src/features/tasks/label-colors";
import { Labels } from "#src/server/tasks/labels.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * Task labels, the simple version (task #455): the Task popup's picker ticks the Workspace's labels
 * on and off and makes a new one from its name, with a color of its own or a swatch picked by
 * keyboard; an owner recolors or deletes (archives) a label from its chip; a card shows its labels;
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
          select: {
            labels: {
              where: { label: { archivedAt: null } },
              select: { label: { select: { name: true } } },
            },
          },
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

    // The swatches. Names as the English messages read them, in the palette's order.
    const colorNames = [
      "Gray",
      "Red",
      "Orange",
      "Yellow",
      "Green",
      "Sky",
      "Blue",
      "Indigo",
      "Purple",
      "Pink",
    ];
    const nameOf = (color: string) => colorNames[LABEL_PALETTE.indexOf(color as never)]!;
    const searchInput = '[role="dialog"] input[aria-label="Add or create a label…"]';
    const radio = (color: string) => `input[type="radio"][aria-label="${nameOf(color)}"]`;
    const checkedSwatch = `document.querySelector('input[type="radio"]:checked')?.getAttribute("aria-label")`;
    const dbColor = async (label: string) =>
      (
        await db.label.findFirstOrThrow({
          where: { workspaceId, name: label },
          select: { color: true },
        })
      ).color;
    // A name whose default swatch leaves room for two steps right, so the keys never wrap.
    let swatchName = name("Swatch");
    for (let n = 0; LABEL_PALETTE.indexOf(newLabelColor(swatchName)) > 7; n++)
      swatchName = name(`Swatch${n}`);
    const defaultColor = newLabelColor(swatchName);
    const picked = LABEL_PALETTE[LABEL_PALETTE.indexOf(defaultColor) + 2]!;
    await openPicker();
    await browser("fill", searchInput, swatchName);
    await browser("wait", "--fn", `document.querySelector('input[type="radio"]') !== null`);
    expect(await evaluate<string>(checkedSwatch)).toBe(nameOf(defaultColor));
    // A swatch names itself on hover.
    await browser("hover", `label:has(${radio(picked)})`);
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[role="tooltip"]')?.textContent === ${JSON.stringify(nameOf(picked))}`,
    );
    await shoot("desktop-2c-swatches");
    // Tab from the search passes the create button and reaches the swatches (on the default), the
    // arrows move, Enter creates.
    await browser("focus", searchInput);
    await browser("press", "Tab");
    await browser("press", "Tab");
    expect(
      await evaluate<string>(`document.activeElement?.getAttribute("aria-label") ?? null`),
    ).toBe(nameOf(defaultColor));
    await browser("press", "ArrowRight");
    await browser("press", "ArrowRight");
    expect(await evaluate<string>(checkedSwatch)).toBe(nameOf(picked));
    await browser("press", "Enter");
    await browser("wait", "--fn", `${props}.includes(${JSON.stringify(swatchName)})`);
    expect(await dbColor(swatchName)).toBe(picked);
    // Enter straight from the search makes it in the default color.
    const plainName = name("Plain");
    await openPicker();
    await browser("fill", searchInput, plainName);
    await browser("wait", "--fn", `document.querySelector('input[type="radio"]') !== null`);
    await browser("focus", searchInput);
    await browser("press", "Enter");
    await browser("wait", "--fn", `${props}.includes(${JSON.stringify(plainName)})`);
    expect(await dbColor(plainName)).toBe(newLabelColor(plainName));
    await browser("press", "Escape");
    await browser("wait", "--fn", `${menu} === null`);

    // An owner recolors a label from its chip: a click on a swatch applies it and closes.
    const chipSelector = (label: string) =>
      `[role="dialog"] button[aria-label="Change color of ${label}"]`;
    const chipDot = (label: string) =>
      `document.querySelector(${JSON.stringify(chipSelector(label))})?.querySelector("svg")?.getAttribute("class") ?? ""`;
    expect(await evaluate<string>(chipDot(name("Bug")))).toContain("text-utility-red-500");
    await browser("click", chipSelector(name("Bug")));
    await browser(
      "wait",
      "--fn",
      `document.querySelector('input[type="radio"][aria-label="Purple"]') !== null`,
    );
    await settled();
    await shoot("desktop-4-recolor");
    await browser("click", 'label:has(input[type="radio"][aria-label="Purple"])');
    await browser("wait", "--fn", `${chipDot(name("Bug"))}.includes("text-utility-purple-500")`);
    await browser(
      "wait",
      "--fn",
      `document.querySelector('input[type="radio"][aria-label="Purple"]') === null`,
    );
    expect(await dbColor(name("Bug"))).toBe("purple");

    // Delete archives the label after a confirmation: off the Task, out of the picker and the
    // filter, its row kept.
    await browser("click", chipSelector(name("Design")));
    const deleteItem = `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Delete label")`;
    await browser("wait", "--fn", `${deleteItem} != null`);
    await evaluate(`(${deleteItem}.click(), true)`);
    const confirmTitle = `[...document.querySelectorAll("h2, [slot=title]")].find((h) => h.textContent.includes("Delete label “${name("Design")}”?"))`;
    await browser("wait", "--fn", `${confirmTitle} != null`);
    await settled();
    await shoot("desktop-5-delete-confirm");
    const confirmButton = `[...${confirmTitle}.closest('[role="dialog"], [role="alertdialog"]').querySelectorAll("button")].find((b) => b.textContent.trim() === "Delete label")`;
    await evaluate(`(${confirmButton}.click(), true)`);
    await browser("wait", "--fn", `${confirmTitle} == null`);
    await browser("wait", "--fn", `!${props}.includes(${JSON.stringify(name("Design"))})`);
    const archived = await db.label.findFirstOrThrow({
      where: { workspaceId, name: name("Design") },
      select: { archivedAt: true },
    });
    expect(archived.archivedAt).not.toBeNull();
    expect(await onTask()).not.toContain(name("Design"));
    await openPicker();
    expect(await evaluate<boolean>(`${item(name("Design"))} == null`)).toBe(true);
    expect(await evaluate<boolean>(`${item(name("Bug"))} != null`)).toBe(true);
    await browser("press", "Escape");
    await browser("wait", "--fn", `${menu} === null`);
    void 0;
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
    // The deleted label is not offered by the filter; the others are.
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}?view=tasks`);
    await browser("wait", "--fn", `${pageHydrated} && ${shows(labelled)}`);
    await evaluate(
      `([...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Filter").click(), true)`,
    );
    const filterItem = (text: string) =>
      `[...document.querySelectorAll('[role^="menuitem"]')].find((el) => el.textContent.trim().startsWith(${JSON.stringify(text)}))`;
    await browser("wait", "--fn", `${filterItem("Labels")} != null`);
    await evaluate(`(${filterItem("Labels")}.click(), true)`);
    await browser("wait", "--fn", `${filterItem(name("Bug"))} != null`);
    expect(await evaluate<boolean>(`${filterItem(name("Design"))} == null`)).toBe(true);

    await browser("set", "viewport", "390", "844");
    await browser("open", popup);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && ${dialog}?.textContent.includes(${JSON.stringify(labelled)}) === true`,
    );
    // A phone's popup may show only the title until its details are asked for.
    await evaluate(`(${dialog}.querySelector('button[aria-label="Show details"]')?.click(), true)`);
    await browser("wait", "--fn", `${dialog}.querySelector('[aria-label="Edit labels"]') !== null`);
    await openPicker();
    await shoot("phone-1-picker");
    // Phone: the create state with its swatches, the recolor popover (closed by the back gesture)
    // and the delete confirmation.
    await browser("fill", searchInput, name("Phonelabel"));
    await browser("wait", "--fn", `document.querySelector('input[type="radio"]') !== null`);
    await shoot("phone-2-create");
    // The first Esc clears the typed name, the second closes the picker.
    await browser("press", "Escape");
    await browser("press", "Escape");
    await browser("wait", "--fn", `${menu} === null`);
    // The picker's history entry is popped asynchronously; let it settle before the next opens.
    await Bun.sleep(500);
    await browser("click", chipSelector(name("Bug")));
    await browser(
      "wait",
      "--fn",
      `document.querySelector('input[type="radio"][aria-label="Red"]') !== null`,
    );
    await shoot("phone-3-recolor");
    await browser("back");
    await browser(
      "wait",
      "--fn",
      `document.querySelector('input[type="radio"][aria-label="Red"]') === null`,
    );
    expect(await evaluate<boolean>(`${dialog} !== null`)).toBe(true);
    await browser("click", chipSelector(name("Bug")));
    await browser("wait", "--fn", `${deleteItem} != null`);
    await evaluate(`(${deleteItem}.click(), true)`);
    await browser("wait", "--fn", `${confirmTitle.replace(name("Design"), name("Bug"))} != null`);
    await shoot("phone-4-delete-confirm");
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.label
      .deleteMany({ where: { workspaceId, name: { endsWith: tail } } })
      .catch(() => undefined);
    await db.$disconnect();
  }
}, 240_000);

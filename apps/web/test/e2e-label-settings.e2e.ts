import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { LabelGroups } from "#src/server/tasks/label-groups.server";
import { Labels } from "#src/server/tasks/labels.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/**
 * Settings → Labels (task #508): every label, by group, with how many Tasks carry it; an owner
 * makes one, renames one (a taken name is refused, and another open page shows the new name at
 * once), recolors one, archives one that two Tasks carry (the question says so), restores it, and
 * deletes it for good from the archived list (it comes off both Tasks). A plain member reads the
 * same page with no menus, and the label picker offers "View all labels" instead of "Manage
 * labels". Desktop and phone, light and dark.
 *
 * Opt-in like the other browser E2Es: real local Web, Centrifugo behind the page's own origin
 * (`COFORGE_E2E_CENTRIFUGO_URL`), and `agent-browser`. The labels, their group, the channel and its
 * Tasks are seeded per run and removed after it. The member's view is read in a Workspace the run
 * makes (a seeded owner, the dev user a member), so the shared dev account's role never changes.
 * Screenshots go under `.amp/e2e/label-settings/`.
 */
const { origin: webOrigin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin) throw new Error("COFORGE_E2E_CENTRIFUGO_URL is required");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/label-settings");

test("an owner manages the Workspace's labels on their own page; a member reads it", async () => {
  const proxy = sameOriginProxy(webOrigin, centrifugoOrigin);
  const origin = proxy.origin;
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `label-settings-${process.pid}`);
  const other = browserSession(browserPath, `label-settings-other-${process.pid}`);
  const labels = new Labels(db);
  const board = new TaskBoard(db);
  const experiments = new PrismaExperimentsRepository(db);
  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    include: { workspace: { select: { slug: true } } },
  });
  const { workspaceId, workspace } = membership;
  const tail = `${process.pid}-${Date.now()}`.slice(-5);
  const name = (base: string) => `${base} ${tail}`;
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-labels-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }] },
    },
  });
  const before = (await experiments.read(workspaceId)).taskConversations;
  const made: string[] = [];
  /** The Workspace the member view is read in, made by this run and removed after it. */
  const seeded: { owner?: { id: string }; workspace?: { id: string; slug: string } } = {};
  let groupId: string | undefined;
  try {
    await experiments.write(workspaceId, "taskConversations", true);
    const group = await new LabelGroups(db).create(workspaceId, DEV_BROWSER_USER.id, {
      name: name("Type"),
      selection: "multiple",
    });
    groupId = group.id;
    const bug = await labels.create(workspaceId, DEV_BROWSER_USER.id, {
      name: name("Bug"),
      color: "error",
      description: "Something broken",
      group: group.name,
    });
    const docs = await labels.create(workspaceId, DEV_BROWSER_USER.id, { name: name("Docs") });
    made.push(bug.id, docs.id);
    const as = { workspaceId, userId: DEV_BROWSER_USER.id };
    const created = await board.execute(as, {
      idempotencyKey: crypto.randomUUID(),
      conversationId: channel.id,
      operation: "create",
      titles: [name("First"), name("Second")],
    } as Parameters<TaskBoard["execute"]>[1]);
    for (const task of created.tasks)
      await board.execute(as, {
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        operation: "amend",
        number: task.number,
        labels: [bug.name],
      } as Parameters<TaskBoard["execute"]>[1]);

    const page = `${origin}/en/w/${workspace.slug}/settings?section=labels`;
    const row = (label: string) =>
      `document.querySelector('[data-label-row=${JSON.stringify(label)}]')`;
    const button = (text: string, within = "document") =>
      `[...${within}.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
    const item = (text: string) =>
      `[...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.trim() === ${JSON.stringify(text)})`;
    const click = (selector: string) => evaluate(`(${selector}.click(), true)`);
    const settled = `document.getAnimations().every((a) => a.playState !== "running")`;
    const shoot = async (shot: string) => {
      await browser("wait", "--fn", settled);
      await browser("screenshot", join(artifacts, `${shot}.png`));
      await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
      await browser("screenshot", join(artifacts, `${shot}-dark.png`));
      await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    };
    const menu = async (label: string, action: string) => {
      await browser("wait", "--fn", `${dialogsOpen} === 0 && ${settled}`);
      // An earlier row's mark would be clicked first.
      await evaluate(
        `([...document.querySelectorAll("[data-e2e]")].forEach((el) => el.removeAttribute("data-e2e")), true)`,
      );
      await evaluate(
        `(${row(label)}.querySelector('button[aria-label="Actions for ${label}"]').setAttribute("data-e2e", "more"), true)`,
      );
      await browser("click", '[data-e2e="more"]');
      await browser("wait", "--fn", `${item(action)} !== undefined`);
      await evaluate(`(${item(action)}.setAttribute("data-e2e", "item"), true)`);
      await browser("click", '[data-e2e="item"]');
    };
    const dialogsOpen = `document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length`;
    const until = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 60 && !(await check()); i++) await Bun.sleep(100);
      expect(await check()).toBe(true);
    };
    const labelRow = (id: string) => db.label.findUnique({ where: { id } });
    /** Opens the first Task's popup and its label picker; answers the link to this page. */
    const pickerLink = async (
      popup = `${origin}/en/w/${workspace.slug}/channel/${channel.id}?task=${created.tasks[0]!.number}`,
    ) => {
      await browser("open", popup);
      await browser(
        "wait",
        "--fn",
        `${pageHydrated} && document.querySelector('[aria-label="Edit labels"]') !== null`,
      );
      await browser("click", '[aria-label="Edit labels"]');
      const link = `document.querySelector('a[href*="section=labels"]')`;
      await browser("wait", "--fn", `${link} !== null`);
      return evaluate<string>(`${link}.textContent.trim()`);
    };
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "1280", "860");
    await browser("open", page);
    await browser("wait", "--fn", `${pageHydrated} && ${row(name("Bug"))} !== null`);
    expect(await evaluate<string>(`${row(name("Bug"))}.textContent`)).toContain("2 tasks");
    // The group heads its labels.
    expect(
      await evaluate<string>(
        `document.querySelector('section[aria-label=${JSON.stringify(name("Type"))}]')?.textContent ?? ""`,
      ),
    ).toContain(name("Bug"));
    await shoot("desktop-1-list");

    // Make one.
    await click(button("New label"));
    await browser("fill", 'input[aria-label="Label name"]', name("Launch"));
    await click(button("Create label"));
    await until(
      async () => (await db.label.count({ where: { workspaceId, name: name("Launch") } })) === 1,
    );
    made.push(
      (await db.label.findFirstOrThrow({ where: { workspaceId, name: name("Launch") } })).id,
    );
    await browser("wait", "--fn", `${row(name("Launch"))} !== null`);

    // Rename: a taken name is refused; then a new one, which another open page shows live.
    await other.browser("set", "viewport", "1280", "860");
    await other.browser("open", page);
    await other.browser("wait", "--fn", `${pageHydrated} && ${row(name("Docs"))} !== null`);
    await menu(name("Docs"), "Rename");
    const field = `input[aria-label="New name for ${name("Docs")}"]`;
    await browser("wait", "--fn", `document.querySelector(${JSON.stringify(field)}) !== null`);
    await browser("fill", field, name("bug"));
    await browser("press", "Enter");
    await browser(
      "wait",
      "--fn",
      `(${row(name("Docs"))}?.textContent ?? "").includes("already exists")`,
    );
    await shoot("desktop-2-name-taken");
    expect((await labelRow(docs.id))!.name).toBe(name("Docs"));
    await browser("fill", field, name("Guides"));
    await browser("press", "Enter");
    await until(async () => (await labelRow(docs.id))!.name === name("Guides"));
    await other.browser("wait", "--fn", `${row(name("Guides"))} !== null`);

    // Recolor.
    await menu(name("Guides"), "Change color");
    await browser(
      "wait",
      "--fn",
      `${row(name("Guides"))}?.querySelector('[aria-label="Blue"]') != null`,
    );
    await shoot("desktop-3-color");
    await click(`${row(name("Guides"))}.querySelector('[aria-label="Blue"]').closest("label")`);
    await until(async () => (await labelRow(docs.id))!.color === "blue");
    // Picking saved it and closed the swatches.
    await browser(
      "wait",
      "--fn",
      `${row(name("Guides"))}?.querySelector('[aria-label="Blue"]') == null`,
    );
    // Focus came back to the row's menu button, not the page.
    const onMenuButton = (label: string) =>
      `document.activeElement === ${row(label)}?.querySelector('button[aria-label="Actions for ${label}"]')`;
    await browser("wait", "--fn", onMenuButton(name("Guides")));

    // With the keyboard: the arrows move the pick, Enter saves it.
    await menu(name("Guides"), "Change color");
    const picked = `${row(name("Guides"))}?.querySelector('input[type="radio"]:checked')`;
    await browser("wait", "--fn", `${picked} != null`);
    await evaluate(`(${picked}.focus(), true)`);
    await browser("press", "ArrowRight");
    await browser("press", "Enter");
    await until(async () => (await labelRow(docs.id))!.color === "indigo");
    await browser("wait", "--fn", onMenuButton(name("Guides")));
    // And Space saves the one the arrows moved to.
    await menu(name("Guides"), "Change color");
    await browser("wait", "--fn", `${picked} != null`);
    await evaluate(`(${picked}.focus(), true)`);
    await browser("press", "ArrowLeft");
    await browser("press", "Space");
    await until(async () => (await labelRow(docs.id))!.color === "blue");

    // Archive one two Tasks carry: the question says so; it moves to Archived.
    await menu(name("Bug"), "Archive");
    await browser(
      "wait",
      "--fn",
      `(document.querySelector('[role="dialog"], [role="alertdialog"]')?.textContent ?? "").includes("2 tasks use it")`,
    );
    await shoot("desktop-4-archive");
    await click(
      button("Archive", `document.querySelector('[role="dialog"], [role="alertdialog"]')`),
    );
    await until(async () => (await labelRow(bug.id))!.archivedAt !== null);
    await browser(
      "wait",
      "--fn",
      `${dialogsOpen} === 0 && ${button("Archived (1)")} !== undefined`,
    );
    await click(button("Archived (1)"));
    await browser("wait", "--fn", `${row(name("Bug"))} !== null`);
    await shoot("desktop-5-archived");

    // Restore, archive again, then delete for good: it comes off both Tasks.
    await menu(name("Bug"), "Restore");
    await until(async () => (await labelRow(bug.id))!.archivedAt === null);
    await menu(name("Bug"), "Archive");
    await browser(
      "wait",
      "--fn",
      `${button("Archive", `document.querySelector('[role="dialog"], [role="alertdialog"]')`)} !== undefined`,
    );
    await click(
      button("Archive", `document.querySelector('[role="dialog"], [role="alertdialog"]')`),
    );
    await until(async () => (await labelRow(bug.id))!.archivedAt !== null);
    await browser(
      "wait",
      "--fn",
      `${dialogsOpen} === 0 && ${button("Archived (1)")} !== undefined`,
    );
    if (!(await evaluate<boolean>(`${row(name("Bug"))} !== null`)))
      await click(button("Archived (1)"));
    await menu(name("Bug"), "Delete permanently");
    await browser(
      "wait",
      "--fn",
      `(document.querySelector('[role="dialog"], [role="alertdialog"]')?.textContent ?? "").includes("It comes off 2 tasks")`,
    );
    await shoot("desktop-6-delete");
    await click(
      button(
        "Delete permanently",
        `document.querySelector('[role="dialog"], [role="alertdialog"]')`,
      ),
    );
    await until(async () => (await labelRow(bug.id)) === null);
    expect(await db.taskLabel.count({ where: { labelId: bug.id } })).toBe(0);

    // The task's label picker leads here: "Manage labels" for an owner.
    expect(await pickerLink()).toBe("Manage labels");
    await shoot("desktop-8-picker-link");

    // The phone.
    await browser("set", "viewport", "390", "844");
    await browser("open", page);
    // A phone opens Settings on its list of sections, as for every section but Integrations.
    await browser("wait", "--fn", `${pageHydrated} && ${button("Labels")} !== undefined`);
    // The list is in the page but hidden behind it; the section opens from the list.
    await click(button("Labels"));
    await browser("wait", "--fn", `${row(name("Guides"))}?.checkVisibility() === true`);
    await shoot("phone-1-list");

    // A plain member, in a Workspace of this run's own (a seeded owner; the dev user only a
    // member there), so the shared dev account's role is never touched: the same list, no
    // menus, a note saying who may change labels, and "View all labels" in the picker.
    seeded.owner = await db.user.create({
      data: { username: `labels-owner-${tail}`, displayName: "Labels Owner" },
    });
    seeded.workspace = await db.workspace.create({
      data: {
        slug: `e2e-labels-${tail}`,
        name: `Labels ${tail}`,
        experiments: { taskConversations: true },
        members: {
          create: [
            { userId: seeded.owner.id, role: "owner" },
            { userId: DEV_BROWSER_USER.id, role: "member" },
          ],
        },
      },
    });
    const theirs = seeded.workspace;
    await labels.create(theirs.id, seeded.owner.id, { name: name("Theirs") });
    const theirChannel = await db.conversation.create({
      data: {
        workspaceId: theirs.id,
        channelName: `e2e-labels-theirs-${tail}`,
        description: "",
        members: { create: [{ userId: seeded.owner.id }, { userId: DEV_BROWSER_USER.id }] },
      },
    });
    const [theirTask] = (
      await board.execute({ workspaceId: theirs.id, userId: seeded.owner.id }, {
        idempotencyKey: crypto.randomUUID(),
        conversationId: theirChannel.id,
        operation: "create",
        titles: [name("Their task")],
      } as Parameters<TaskBoard["execute"]>[1])
    ).tasks;
    await browser("set", "viewport", "1280", "860");
    await browser("open", `${origin}/en/w/${theirs.slug}/settings?section=labels`);
    await browser("wait", "--fn", `${pageHydrated} && ${row(name("Theirs"))} !== null`);
    await browser(
      "wait",
      "--fn",
      `document.body.textContent.includes("Only Workspace owners and admins can rename")`,
    );
    expect(
      await evaluate<number>(
        `document.querySelectorAll('button[aria-label^="Actions for"]').length`,
      ),
    ).toBe(0);
    await shoot("desktop-7-member");
    expect(
      await pickerLink(
        `${origin}/en/w/${theirs.slug}/channel/${theirChannel.id}?task=${theirTask!.number}`,
      ),
    ).toBe("View all labels");
    expect((await browser("errors")).trim()).toBe("");
  } finally {
    if (seeded.workspace)
      await db.workspace.deleteMany({ where: { id: seeded.workspace.id } }).catch(() => undefined);
    if (seeded.owner)
      await db.user.deleteMany({ where: { id: seeded.owner.id } }).catch(() => undefined);
    await browser("close").catch(() => undefined);
    await other.browser("close").catch(() => undefined);
    proxy.stop();
    await db.label.deleteMany({ where: { id: { in: made } } }).catch(() => undefined);
    if (groupId) await db.labelGroup.deleteMany({ where: { id: groupId } }).catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await experiments.write(workspaceId, "taskConversations", before).catch(() => undefined);
    await db.$disconnect();
  }
}, 240_000);

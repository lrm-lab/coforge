import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";

/**
 * The Tasks page and a channel's Tasks tab in a real browser. The Tasks page lists channel Tasks
 * and none from a direct message (not even the viewer's own), and offers no way to create a Task.
 * A channel's Tasks tab creates them: the dialog refuses an empty title, offers first among its
 * Projects the one the viewer last filed a Task under there (task #485), and creates the Task in
 * that channel under the one picked.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`, the dev user a member of
 * its Workspace (seed-dev). Each run seeds a fresh channel, Agent and direct message. Screenshots
 * are written under `.amp/e2e/tasks-create-and-scope/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/tasks-create-and-scope");

test("the Tasks page shows channel Tasks only, and a channel's Tasks tab creates them one after another", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `tasks-create-${process.pid}`;
  async function browser(...args: string[]) {
    const child = Bun.spawn([browserPath!, "--session", session, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`Browser ${args[0]} failed: ${stderr}`);
    return stdout;
  }
  /** Waits for `condition`, failing with its text rather than at the test timeout; a first page
   * load compiles on the dev server, so it gets longer. */
  const waitFor = async (condition: string, ms = 20_000) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        browser("wait", "--fn", condition),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out waiting for ${condition}`)), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const byText = (selector: string, text: string) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((element) => element.textContent.trim() === ${JSON.stringify(text)}).at(-1)`;
  const bodyHas = (text: string) => `document.body.textContent.includes(${JSON.stringify(text)})`;
  const dialogOpen = `document.querySelector('[role="dialog"] [aria-label="Task title"]') !== null`;
  const titleField = '[role="dialog"] [aria-label="Task title"]';

  const suffix = `${process.pid}-${Date.now()}`;
  const channelTitle = `Channel work ${suffix}`;
  const directTitle = `Direct work ${suffix}`;
  const created = [`First new ${suffix}`];
  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const workspacePath = `/en/w/${membership.workspace.slug}`;
  const workspaceId = membership.workspaceId;
  const project = await db.project.create({
    data: { workspaceId, name: `Launch plan ${suffix}`, slug: `e2e-launch-${suffix}` },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-tasks-${suffix}`,
      description: "",
      // The viewer last filed a Task here under the Project, so a new one starts there.
      members: { create: { userId: DEV_BROWSER_USER.id, lastTaskProjectId: project.id } },
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-tasks-agent-${suffix}`,
      displayName: `Tasks Agent ${suffix}`,
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
  const direct = await db.conversation.create({
    data: {
      workspaceId,
      directKey: [DEV_BROWSER_USER.id, agent.id].sort().join(":"),
      members: {
        create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }],
      },
    },
  });
  try {
    const board = new TaskBoard(db);
    const as = { workspaceId, userId: DEV_BROWSER_USER.id };
    for (const [conversationId, title] of [
      [channel.id, channelTitle],
      [direct.id, directTitle],
    ] as const)
      await board.execute(as, {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        conversationId,
        title,
      });
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");

    // The Tasks page: the channel's Task, not the direct message's, and no "+" to create one.
    await browser("open", `${origin}${workspacePath}/tasks`);
    await waitFor(bodyHas(channelTitle), 60_000);
    expect(await browser("eval", bodyHas(directTitle))).toContain("false");
    expect(
      await browser(
        "eval",
        `document.querySelectorAll('[aria-label^="New task in"]').length === 0 && ${byText("button", "Create task")} === undefined`,
      ),
    ).toContain("true");
    await browser("screenshot", join(artifacts, "tasks-page.png"));

    // The channel's Tasks tab creates them. A click before hydration opens nothing: retry.
    await browser("open", `${origin}${workspacePath}/channel/${channel.id}?view=tasks`);
    await waitFor(bodyHas(channelTitle), 60_000);
    for (let attempt = 0; ; attempt += 1) {
      await browser("eval", `${byText("button", "Create task")}?.click()`);
      if (
        await waitFor(dialogOpen, 5_000).then(
          () => true,
          () => false,
        )
      )
        break;
      if (attempt === 5) throw new Error("the create dialog never opened");
    }

    // No title at all is refused in place.
    await browser(
      "eval",
      `document.querySelector('[role="dialog"] button[type="submit"]').click()`,
    );
    await waitFor(
      `document.querySelector('[role="dialog"] [role="alert"]')?.textContent.includes("Add a title for the task.")`,
    );
    await browser("screenshot", join(artifacts, "create-empty.png"));

    // The dialog is laid out as the Task popup: where it goes, a To do title, then the details.
    // Where it goes is the channel as the sidebar shows it: its group avatar and its name, no `#`.
    expect(
      await browser(
        "eval",
        `(() => { const d = document.querySelector('[role="dialog"]'); return d.textContent.includes(${JSON.stringify(channel.channelName)}) && !d.textContent.includes("#${channel.channelName}") && d.querySelector(".avatar-group") !== null; })()`,
      ),
    ).toContain("true");
    // Its Project starts empty; the last-used one heads the picker's options (Frank, 11-06).
    await browser("click", '[role="dialog"] button[aria-label="Change project: No project"]');
    const lastUsed = `[...document.querySelectorAll('[role^="menuitem"], [role="option"]')][0]`;
    await waitFor(`${lastUsed}?.textContent.includes(${JSON.stringify(project.name)})`);
    expect(await browser("eval", `${lastUsed}.textContent`)).toContain("Last used");
    await browser("eval", `${lastUsed}.click()`);
    await waitFor(
      `document.querySelector('[role="dialog"] form > [data-layout="create"]')?.textContent.includes(${JSON.stringify(project.name)})`,
    );
    // One Task per dialog: it lands with what was set, and the dialog closes.
    await browser("fill", titleField, created[0]!);
    await browser(
      "fill",
      '[role="dialog"] textarea[aria-label="Add a description…"]',
      `Notes for ${suffix}`,
    );
    for (const theme of ["light", "dark"] as const) {
      if (theme === "dark")
        await browser("eval", `document.documentElement.classList.add("dark-mode")`);
      await browser("screenshot", join(artifacts, `create-${theme}.png`));
    }
    await browser("eval", `document.documentElement.classList.remove("dark-mode")`);
    await browser(
      "eval",
      `document.querySelector('[role="dialog"] button[type="submit"]').click()`,
    );
    await waitFor(`!(${dialogOpen})`);
    await waitFor(bodyHas(created[0]!));
    const rows = await db.task.findMany({
      where: { conversationId: channel.id, title: { in: created } },
      select: { title: true, status: true, description: true, projectId: true },
    });
    expect(rows).toEqual([
      {
        title: created[0]!,
        status: "todo",
        description: `Notes for ${suffix}`,
        projectId: project.id,
      },
    ]);
    await browser("screenshot", join(artifacts, "created.png"));

    // On a phone the dialog is a full sheet, as the Task popup is.
    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}${workspacePath}/channel/${channel.id}?view=tasks`);
    await waitFor(bodyHas(created[0]!), 60_000);
    for (let attempt = 0; !(await browser("eval", dialogOpen)).includes("true"); attempt += 1) {
      if (attempt === 10) throw new Error("the create dialog never opened on a phone");
      await browser("eval", `${byText("button", "Create task")}?.click()`);
      await Bun.sleep(500);
    }
    await browser("fill", titleField, `Phone ${suffix}`);
    await browser("screenshot", join(artifacts, "create-phone.png"));
    await browser("eval", `document.documentElement.classList.add("dark-mode")`);
    await browser("screenshot", join(artifacts, "create-phone-dark.png"));
    // A page of its own (task #54): Cancel, the heading and Create across the top, the desktop's
    // footer gone, and the chips one row at the foot, where the keyboard leaves them in reach.
    const phoneLayout = JSON.parse(
      await browser(
        "eval",
        `JSON.stringify((() => {
          const form = document.querySelector('[role="dialog"] form');
          const shown = (el) => el.getClientRects().length > 0;
          const submits = [...form.querySelectorAll("button")].filter((b) => shown(b) && ["Create", "Create task"].includes(b.textContent.trim()));
          const chips = [...form.querySelector(':scope > [data-layout="create"]').children];
          return {
            submits: submits.map((b) => b.textContent.trim()),
            topBar: submits[0].getBoundingClientRect().top < form.querySelector('[aria-label="Task title"]').getBoundingClientRect().top,
            cancel: [...form.querySelectorAll("button")].some((b) => shown(b) && b.textContent.trim() === "Cancel"),
            rows: new Set(chips.map((c) => Math.round(c.getBoundingClientRect().top))).size,
          };
        })())`,
      ).then((out) => JSON.parse(out)),
    );
    expect(phoneLayout).toEqual({ submits: ["Create"], topBar: true, cancel: true, rows: 1 });
    // Cancel puts the page away, not what was typed: opened again, the title is still there.
    await browser("find", "role", "button", "click", "--name", "Cancel");
    await waitFor(`document.querySelector('[role="dialog"]') === null`);
    for (let attempt = 0; !(await browser("eval", dialogOpen)).includes("true"); attempt += 1) {
      if (attempt === 10) throw new Error("the create page never opened again");
      await browser("eval", `${byText("button", "Create task")}?.click()`);
      await Bun.sleep(500);
    }
    expect(
      await browser("eval", `document.querySelector(${JSON.stringify(titleField)}).value`),
    ).toContain(`Phone ${suffix}`);
    await browser("find", "role", "button", "click", "--name", "Create");
    let phoneMade = null;
    for (let tries = 0; tries < 40 && !phoneMade; tries++) {
      phoneMade = await db.task.findFirst({ where: { title: `Phone ${suffix}` } });
      if (!phoneMade) await Bun.sleep(250);
    }
    expect(phoneMade).not.toBeNull();
  } finally {
    await db.conversation
      .deleteMany({ where: { id: { in: [channel.id, direct.id] } } })
      .catch(() => {});
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => {});
    await db.project.deleteMany({ where: { id: project.id } }).catch(() => {});
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 300_000);

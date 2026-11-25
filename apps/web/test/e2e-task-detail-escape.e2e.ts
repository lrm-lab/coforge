import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { peopleDirectKey } from "#src/features/conversations/direct-key";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import {
  animationsSettled,
  browserSession,
  devBrowserWorkspace,
  elementAtRest,
  localBrowserE2e,
  menuItemNamed,
  pageHydrated,
} from "./helpers/browser-e2e";
import {
  nonTaskDialogs,
  taskDetail,
  taskDetailPanels,
  taskDetailSheetEntered,
} from "./helpers/task-detail-e2e";

const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/task-detail-escape");

test("mobile TaskDetentSheet Escape handles step back, layers, header/dialog/body focus, and cross-channel stack", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `task-esc-sheet-${process.pid}`);
  const board = new TaskBoard(db);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  const chAName = `e2e-esc-a-${tail}`;
  const chBName = `e2e-esc-b-${tail}`;
  const channelA = await db.conversation.create({
    data: {
      workspaceId,
      channelName: chAName,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }] },
    },
  });
  const channelB = await db.conversation.create({
    data: {
      workspaceId,
      channelName: chBName,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }] },
    },
  });
  try {
    const run = (conversationId: string, command: Record<string, unknown>) =>
      board.execute({ workspaceId, userId: DEV_BROWSER_USER.id }, {
        idempotencyKey: crypto.randomUUID(),
        conversationId,
        ...command,
      } as Parameters<TaskBoard["execute"]>[1]);
    const parentTitle = `Sheet parent ${tail}`;
    const childTitle = `Sheet child ${tail}`;
    const crossTitle = `Sheet cross ${tail}`;
    const parent = (await run(channelA.id, { operation: "create", title: parentTitle })).tasks[0]!
      .number;
    const child = (
      await run(channelA.id, {
        operation: "create",
        title: childTitle,
        parent: { number: parent },
      })
    ).tasks[0]!.number;
    await run(channelB.id, {
      operation: "create",
      title: crossTitle,
      parent: { number: parent, channel: chAName },
    });

    const dialog = `document.querySelector('[role="dialog"]')`;
    const topDialog = `[...document.querySelectorAll('[role="dialog"]')].at(-1)`;
    const showing = (title: string, target = dialog) =>
      `${target}?.querySelector("h2")?.textContent.includes(${JSON.stringify(title)}) === true`;
    const settled = () =>
      browser("wait", "--fn", `${taskDetailSheetEntered} && ${animationsSettled()}`);
    const clickEl = async (expr: string) => {
      await settled();
      await browser("wait", "--fn", elementAtRest(expr));
      expect(
        await evaluate<boolean>(
          `(() => { document.querySelectorAll("[data-e2e-press]").forEach((el) => el.removeAttribute("data-e2e-press")); const el = ${expr}; if (!el) return false; el.setAttribute("data-e2e-press", ""); return true; })()`,
        ),
      ).toBe(true);
      await browser("click", "[data-e2e-press]");
    };
    const shoot = async (name: string) => {
      await settled();
      await browser("screenshot", join(artifacts, `${name}.png`));
      await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
      await settled();
      await browser("screenshot", join(artifacts, `${name}-dark.png`));
      await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    };

    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "390", "844");
    const parentUrl = `${origin}/en/w/${workspace.slug}/channel/${channelA.id}?task=${parent}`;

    await browser("open", parentUrl);
    await browser("wait", "--fn", `${pageHydrated} && ${showing(parentTitle)}`);
    await browser("wait", "--fn", `${dialog}.textContent.includes(${JSON.stringify(childTitle)})`);
    await shoot("phone-parent");

    const openChildStep = async () => {
      await browser(
        "wait",
        "--fn",
        `${dialog}.textContent.includes(${JSON.stringify(childTitle)})`,
      );
      await clickEl(
        `[...${dialog}.querySelectorAll('button, [role="button"], [role="row"]')].find((el) => el.textContent.includes(${JSON.stringify(childTitle)}))`,
      );
      await browser("wait", "--fn", showing(childTitle));
      await settled();
    };

    await openChildStep();

    await clickEl(
      `${dialog}.querySelector(${JSON.stringify(`button[aria-label="More actions for task #${child}"]`)})`,
    );
    await browser("wait", "--fn", `document.querySelector('[role="menu"]') !== null`);
    await browser("press", "Escape");
    await browser("wait", "--fn", `document.querySelector('[role="menu"]') === null`);
    expect(await evaluate<boolean>(showing(childTitle))).toBe(true);

    await clickEl(
      `${dialog}.querySelector(${JSON.stringify(`button[aria-label="More actions for task #${child}"]`)})`,
    );
    await browser("wait", "--fn", `Boolean(${menuItemNamed("View full history")})`);
    await browser("find", "role", "menuitem", "click", "--name", "View full history");
    await browser(
      "wait",
      "--fn",
      `[...${dialog}.querySelectorAll("button")].some((el) => el.textContent.trim() === "Back") && document.querySelector('[role="menu"]') === null && ${animationsSettled()}`,
    );
    await browser("press", "Escape");
    await browser(
      "wait",
      "--fn",
      `![...${dialog}.querySelectorAll("button")].some((el) => el.textContent.trim() === "Back")`,
    );
    expect(await evaluate<boolean>(showing(childTitle))).toBe(true);

    const composer = `${dialog}.querySelector("textarea[data-composer]")`;
    await browser("wait", "--fn", `${composer} !== null`);
    await evaluate(
      `(() => { const el = ${composer}; el.focus(); el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 229, isComposing: true, bubbles: true, cancelable: true })); return true; })()`,
    );
    await settled();
    expect(await evaluate<boolean>(showing(childTitle))).toBe(true);

    await evaluate(`(${dialog}.setAttribute("tabindex", "-1"), ${dialog}.focus(), true)`);
    await browser("press", "Escape");
    await browser("wait", "--fn", showing(parentTitle));

    await openChildStep();
    await evaluate(
      `document.querySelector('[data-detent-grab] button[aria-label^="More actions"]')?.focus() ?? true`,
    );
    await browser("press", "Escape");
    await browser("wait", "--fn", showing(parentTitle));

    await openChildStep();
    await evaluate(`(document.activeElement?.blur?.(), true)`);
    await browser("press", "Escape");
    await browser("wait", "--fn", showing(parentTitle));
    await evaluate(`(document.activeElement?.blur?.(), true)`);
    await browser("press", "Escape");
    await browser("wait", "--fn", `${dialog} === null`);

    await browser("open", parentUrl);
    await browser("wait", "--fn", `${pageHydrated} && ${showing(parentTitle)}`);
    await browser("wait", "--fn", `${dialog}.textContent.includes(${JSON.stringify(crossTitle)})`);
    await clickEl(
      `[...${dialog}.querySelectorAll('button, [role="button"], [role="row"]')].find((el) => el.textContent.includes(${JSON.stringify(crossTitle)}))`,
    );
    await browser(
      "wait",
      "--fn",
      `${topDialog} !== ${dialog} && ${showing(crossTitle, topDialog)}`,
    );
    await settled();
    await evaluate(`(${topDialog}.focus(), true)`);
    await browser("press", "Escape");
    await browser("wait", "--fn", `${topDialog} === ${dialog} && ${showing(parentTitle)}`);
    await evaluate(`(${dialog}.focus(), true)`);
    await browser("press", "Escape");
    await browser("wait", "--fn", `${dialog} === null`);
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation
      .deleteMany({ where: { id: { in: [channelA.id, channelB.id] } } })
      .catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);

test("desktop inline TaskDetailPanel closes with Escape from external row focus while preserving inner Escape layers", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `task-esc-inline-${process.pid}`);
  const board = new TaskBoard(db);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  const project = await db.project.create({
    data: { workspaceId, name: `Esc Tree ${tail}`, slug: `esc-tree-${tail}` },
  });
  const peer = await db.user.create({
    data: { username: `esc-peer-${tail}`, displayName: "Esc Peer" },
  });
  await db.workspaceMembership.create({ data: { workspaceId, userId: peer.id } });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-esc-proj-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }] },
    },
  });
  const direct = await db.conversation.create({
    data: {
      workspaceId,
      directKey: peopleDirectKey(DEV_BROWSER_USER.id, peer.id),
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { userId: peer.id }] },
    },
  });
  try {
    const runIn = (conversationId: string) => (command: Record<string, unknown>) =>
      board.execute({ workspaceId, userId: DEV_BROWSER_USER.id }, {
        idempotencyKey: crypto.randomUUID(),
        conversationId,
        ...command,
      } as Parameters<TaskBoard["execute"]>[1]);
    const run = runIn(channel.id);
    const parentTitle = `Tree parent ${tail}`;
    const dmTitle = `Tree dm ${tail}`;
    const candidateTitle = `Tree epic ${tail}`;
    const childTitle = `Tree child ${tail}`;
    const parent = (await run({ operation: "create", title: parentTitle, project: project.slug }))
      .tasks[0]!;
    await runIn(direct.id)({ operation: "create", title: dmTitle, project: project.slug });
    await run({
      operation: "create",
      title: childTitle,
      parent: { number: parent.number },
    });
    await run({ operation: "create", title: candidateTitle, project: project.slug });

    const settled = () => browser("wait", "--fn", animationsSettled());
    const row = (name: string) =>
      `[...document.querySelectorAll('[role="row"]')].find((r) => (r.getAttribute("aria-label") ?? "").includes(${JSON.stringify(name)}))`;
    const showing = (name: string) =>
      `${taskDetail}?.querySelector("h2")?.textContent.includes(${JSON.stringify(name)}) === true`;
    const overlays = nonTaskDialogs(true);
    const shoot = async (name: string) => {
      await settled();
      await browser("screenshot", join(artifacts, `${name}.png`));
      await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
      await settled();
      await browser("screenshot", join(artifacts, `${name}-dark.png`));
      await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    };

    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1280", "860");
    const listUrl = `${origin}/en/w/${workspace.slug}/projects/${project.slug}?tab=tasks&layout=list`;
    await browser("open", listUrl);
    await browser("wait", "--fn", `${pageHydrated} && ${row(dmTitle)} != null`);

    await evaluate(
      `(() => { const r = ${row(dmTitle)}; r.setAttribute("data-e2e-dm-row", ""); return true; })()`,
    );
    await browser("click", "[data-e2e-dm-row]");
    await browser("wait", "--fn", `${showing(dmTitle)}`);
    await settled();
    expect(
      await evaluate<boolean>(
        `Boolean(document.activeElement?.closest('[role="row"]')) && !${taskDetail}.contains(document.activeElement)`,
      ),
    ).toBe(true);
    await shoot("desktop-inline-split");

    await browser("press", "Escape");
    await browser("wait", "--fn", `${taskDetail} === null`);

    await evaluate(`(${row(parentTitle)}.focus(), true)`);
    await browser("press", "Enter");
    await browser("wait", "--fn", `${showing(parentTitle)}`);
    await settled();
    await evaluate(`(${row(parentTitle)}.focus(), true)`);
    expect(
      await evaluate<boolean>(
        `Boolean(document.activeElement?.closest('[role="row"]')) && !${taskDetail}.contains(document.activeElement)`,
      ),
    ).toBe(true);
    await browser("press", "Escape");
    await browser("wait", "--fn", `${taskDetail} === null`);

    await evaluate(`(${row(parentTitle)}.focus(), true)`);
    await browser("press", "Enter");
    await browser("wait", "--fn", `${showing(parentTitle)}`);
    await settled();
    const inlineComposer = `${taskDetail}.querySelector("textarea[data-composer]")`;
    await browser("wait", "--fn", `${inlineComposer} !== null`);
    await evaluate(
      `(() => { const el = ${inlineComposer}; el.focus(); el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 229, isComposing: true, bubbles: true, cancelable: true })); return true; })()`,
    );
    await settled();
    expect(await evaluate<boolean>(showing(parentTitle))).toBe(true);

    const expandSelector = `section[aria-label^="Task #"] button[aria-label="Expand"]`;
    await browser(
      "wait",
      "--fn",
      elementAtRest(`document.querySelector(${JSON.stringify(expandSelector)})`),
    );
    await browser("click", expandSelector);
    await browser(
      "wait",
      "--fn",
      `document.querySelector('section[aria-label^="Task #"] button[aria-label="Restore split view"]') !== null`,
    );
    await evaluate(
      `(${taskDetail}.querySelector("h2").setAttribute("tabindex", "-1"), ${taskDetail}.querySelector("h2").focus(), true)`,
    );
    await browser("press", "Escape");
    await browser(
      "wait",
      "--fn",
      `${showing(parentTitle)} && document.querySelector('section[aria-label^="Task #"] button[aria-label="Expand"]') !== null`,
    );
    await evaluate(`(${taskDetail}.querySelector("h2").focus(), true)`);
    await browser("press", "Escape");
    await browser("wait", "--fn", `${taskDetail} === null`);

    await evaluate(`(${row(parentTitle)}.focus(), true)`);
    await browser("press", "Enter");
    await browser("wait", "--fn", `${showing(parentTitle)}`);
    await settled();

    const moreSelector = `section[aria-label^="Task #"] button[aria-label="More actions for task #${parent.number}"]`;
    await browser(
      "wait",
      "--fn",
      elementAtRest(`document.querySelector(${JSON.stringify(moreSelector)})`),
    );
    await browser("click", moreSelector);
    await browser("wait", "--fn", `document.querySelector('[role="menu"]') !== null`);
    await browser("press", "Escape");
    await browser("wait", "--fn", `document.querySelector('[role="menu"]') === null`);
    await settled();
    expect(await evaluate<boolean>(showing(parentTitle))).toBe(true);

    await browser(
      "wait",
      "--fn",
      elementAtRest(`document.querySelector(${JSON.stringify(moreSelector)})`),
    );
    await browser("click", moreSelector);
    await browser("wait", "--fn", `Boolean(${menuItemNamed("Set parent task…")})`);
    await browser("find", "role", "menuitem", "click", "--name", "Set parent task…");
    await browser("wait", "--fn", `${overlays}.length === 1`);
    await settled();
    await browser("press", "Escape");
    await browser("wait", "--fn", `${overlays}.length === 0`);
    expect(await evaluate<number>(`${taskDetailPanels}.length`)).toBe(1);
    expect(await evaluate<boolean>(showing(parentTitle))).toBe(true);
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation
      .deleteMany({ where: { id: { in: [channel.id, direct.id] } } })
      .catch(() => undefined);
    await db.project.deleteMany({ where: { id: project.id } }).catch(() => undefined);
    await db.workspaceMembership.deleteMany({ where: { userId: peer.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: peer.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);

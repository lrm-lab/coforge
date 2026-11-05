import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { peopleDirectKey } from "#src/features/conversations/direct-key";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/**
 * A Project's task tree (task #462), the list layout of its Tasks tab: each Task under its parent
 * at its level, its sub-tasks' progress, what it waits on (one the viewer cannot read named only
 * as such), its channel, and a sub-task whose parent is in another Project at the top naming
 * that parent. Arrow keys fold and move, Enter opens the popup; a status filter keeps the passing
 * Task's ancestors, read as outside the filter; a channel pick keeps that channel's Tasks; a new
 * sub-task shows without a reload. Desktop and phone, light and dark.
 *
 * Opt-in like the other browser E2Es: real local Web and `agent-browser`. Two Projects, three
 * channels (one private to another person) and their Tasks are seeded per run and removed after
 * it. Screenshots are written under `.amp/e2e/project-task-tree/`.
 */
const { origin: webOrigin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin) throw new Error("COFORGE_E2E_CENTRIFUGO_URL is required");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/project-task-tree");

test("a Project's Tasks tab lists its Tasks as a tree", async () => {
  // Live updates reach the page only through Centrifugo on the page's own origin.
  const proxy = sameOriginProxy(webOrigin, centrifugoOrigin);
  const origin = proxy.origin;
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `project-tree-${process.pid}`);
  const experiments = new PrismaExperimentsRepository(db);
  // Writes announce themselves, as a person's do, so the open page sees them live.
  const centrifugo = createCentrifugoServerApi();
  const board = new TaskBoard(db, {
    realtime: new CentrifugoConversationRealtime(centrifugo),
    publisher: centrifugo,
  });
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  const home = await db.project.create({
    data: { workspaceId, name: `Launch ${tail}`, slug: `launch-${tail}` },
  });
  const other = await db.project.create({
    data: { workspaceId, name: `Brand ${tail}`, slug: `brand-${tail}` },
  });
  const lin = await db.user.create({ data: { username: `lin-t-${tail}`, displayName: "Lin Xia" } });
  await db.workspaceMembership.create({ data: { workspaceId, userId: lin.id } });
  const channel = (name: string, userIds: string[], visibility?: "private") =>
    db.conversation.create({
      data: {
        workspaceId,
        channelName: `${name}-${tail}`,
        description: "",
        ...(visibility && { visibility }),
        members: { create: userIds.map((userId) => ({ userId })) },
      },
    });
  const site = await channel("site", [DEV_BROWSER_USER.id]);
  const ops = await channel("ops", [DEV_BROWSER_USER.id]);
  const closed = await channel("closed", [lin.id], "private");
  const direct = await db.conversation.create({
    data: {
      workspaceId,
      directKey: peopleDirectKey(DEV_BROWSER_USER.id, lin.id),
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { userId: lin.id }] },
    },
  });
  const before = (await experiments.read(workspaceId)).taskConversations;
  try {
    await experiments.write(workspaceId, "taskConversations", true);
    const runIn =
      (conversationId: string, userId = DEV_BROWSER_USER.id) =>
      async (command: Record<string, unknown>) =>
        (
          await board.execute({ workspaceId, userId }, {
            idempotencyKey: crypto.randomUUID(),
            conversationId,
            ...command,
          } as Parameters<TaskBoard["execute"]>[1])
        ).tasks[0]!;
    const inSite = runIn(site.id);
    const project = home.slug;
    const title = (name: string) => `${name} ${tail}`;
    // Ship ├ Copy │ └ Review └ Assets; Domain (waits on Copy and on a task Lin's channel holds);
    // in #ops, Monitoring; Brand guide's sub-task Logo files under this Project.
    const ship = await inSite({ operation: "create", title: title("Ship the site"), project });
    const copy = await inSite({
      operation: "create",
      title: title("Write the copy"),
      parent: { number: ship.number },
    });
    const review = await inSite({
      operation: "create",
      title: title("Review the copy"),
      parent: { number: copy.number },
    });
    const assets = await inSite({
      operation: "create",
      title: title("Make the assets"),
      parent: { number: ship.number },
    });
    const assetsDone = await inSite({
      operation: "create",
      title: title("Pick the fonts"),
      parent: { number: ship.number },
    });
    await inSite({ operation: "claim", number: assetsDone.number });
    await inSite({ operation: "update", number: assetsDone.number, status: "done" });
    const domain = await inSite({
      operation: "create",
      title: title("Buy the domain"),
      project,
      blockedBy: [{ number: copy.number }, { number: review.number }, { number: assets.number }],
    });
    const secret = await runIn(closed.id, lin.id)({ operation: "create", title: title("Budget") });
    await db.taskDependency.create({
      data: {
        taskId: domain.id,
        blockedByTaskId: secret.id,
        conversationId: site.id,
        workspaceId,
        creatorUserId: DEV_BROWSER_USER.id,
      },
    });
    await runIn(ops.id)({ operation: "create", title: title("Set up monitoring"), project });
    const guide = await inSite({
      operation: "create",
      title: title("Brand guide"),
      project: other.slug,
    });
    const logo = await inSite({
      operation: "create",
      title: title("Draw the logo"),
      parent: { number: guide.number },
    });
    await db.task.update({ where: { id: logo.id }, data: { projectId: home.id } });
    // The viewer's DM with Lin files a Task under this Project too.
    await runIn(direct.id)({ operation: "create", title: title("Call the printer"), project });

    await mkdir(artifacts, { recursive: true });
    const shoot = async (name: string) => {
      await browser(
        "wait",
        "--fn",
        `document.getAnimations().every((a) => a.playState !== "running")`,
      );
      await browser("screenshot", join(artifacts, `${name}.png`));
      await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
      // The theme's own colour transitions settle first.
      await browser(
        "wait",
        "--fn",
        `document.getAnimations().every((a) => a.playState !== "running")`,
      );
      await browser("screenshot", join(artifacts, `${name}-dark.png`));
      await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    };
    const tree = `document.querySelector('[role="treegrid"]')`;
    // A row's label starts with its own number and title; a blocker's name comes later in it.
    const row = (name: string) =>
      `[...document.querySelectorAll('[role="row"]')].find((r) => (r.getAttribute("aria-label") ?? "").replace(/^#\\d+ /, "").startsWith(${JSON.stringify(title(name))}))`;
    const attr = (name: string, attribute: string) =>
      evaluate<string | null>(`${row(name)}?.getAttribute(${JSON.stringify(attribute)}) ?? null`);
    const listPage = `${origin}/zh-CN/w/${workspace.slug}/projects/${home.slug}?tab=tasks&layout=list`;

    await browser("set", "viewport", "1280", "860");
    await browser("open", listPage);
    await browser("wait", "--fn", `${pageHydrated} && ${row("Draw the logo")} != null`);
    // Each Task at its level; the finished sub-task is counted, not listed.
    expect(await attr("Ship the site", "aria-level")).toBe("1");
    expect(await attr("Write the copy", "aria-level")).toBe("2");
    expect(await attr("Review the copy", "aria-level")).toBe("3");
    expect(await evaluate<boolean>(`${row("Pick the fonts")} == null`)).toBe(true);
    expect(
      await evaluate<boolean>(`${row("Ship the site")}.textContent.includes("子任务 1/3")`),
    ).toBe(true);
    // What Domain waits on: four Tasks, the first three read out by name with the row, then how
    // many more. Sub-task progress is read out too.
    const domainLabel = (await attr("Buy the domain", "aria-label")) ?? "";
    const blockerNames = [
      `${title("Write the copy")} #${copy.number}`,
      `${title("Review the copy")} #${review.number}`,
      `${title("Make the assets")} #${assets.number}`,
      "无权查看的任务",
    ];
    expect(blockerNames.filter((name) => domainLabel.includes(name))).toHaveLength(3);
    expect(domainLabel).toContain("还有 1 个");
    expect(await attr("Ship the site", "aria-label")).toContain("3 个子任务已完成 1 个");
    expect(
      await evaluate<boolean>(`${row("Buy the domain")}.textContent.includes("等 4 个任务")`),
    ).toBe(true);
    expect(
      await evaluate<boolean>(
        `document.body.textContent.includes(${JSON.stringify(title("Budget"))})`,
      ),
    ).toBe(false);
    // Logo's parent is in the other Project: Logo is at the top, naming it.
    expect(await attr("Draw the logo", "aria-level")).toBe("1");
    expect(
      await evaluate<boolean>(
        `${row("Draw the logo")}.textContent.includes("属于 #${guide.number}")`,
      ),
    ).toBe(true);
    expect(
      await evaluate<boolean>(`${row("Set up monitoring")}.textContent.includes("ops-${tail}")`),
    ).toBe(true);
    await shoot("desktop-tree");

    // The keyboard reaches "Waiting on 4 tasks" from its row with Right.
    await evaluate(
      `([...${row("Buy the domain")}.querySelectorAll("button")].find((b) => b.textContent.includes("等 4 个任务")).setAttribute("data-e2e", "blockers"), true)`,
    );
    await evaluate(`(${row("Buy the domain")}.focus(), true)`);
    await browser("press", "ArrowRight");
    await browser(
      "wait",
      "--fn",
      `document.activeElement === document.querySelector('[data-e2e="blockers"]')`,
    );
    // A press on it lists them all, as a phone has no hover; the Task's popup does not open.
    await browser("click", '[data-e2e="blockers"]');
    const blockers = `document.querySelector('[role="dialog"][aria-label="等待"]')`;
    await browser(
      "wait",
      "--fn",
      `${blockers}?.textContent.includes(${JSON.stringify(title("Write the copy"))}) === true`,
    );
    expect(
      await evaluate<boolean>(
        `${JSON.stringify(blockerNames.map((name) => name.replace(/ #\d+$/, "")))}.every((name) => ${blockers}.textContent.includes(name))`,
      ),
    ).toBe(true);
    await Bun.sleep(500);
    expect(await evaluate<number>(`document.querySelectorAll('[role="dialog"]').length`)).toBe(1);
    await shoot("desktop-tree-blockers");
    await browser("press", "Escape");
    await browser("wait", "--fn", `${blockers} == null`);

    // A Task of the viewer's own DM opens from the tree, as any other does, named for Lin.
    expect(
      await evaluate<boolean>(`${row("Call the printer")}.textContent.includes("Lin Xia")`),
    ).toBe(true);
    await evaluate(`(${row("Call the printer")}.setAttribute("data-e2e", "dm-row"), true)`);
    await browser("click", '[data-e2e="dm-row"]');
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[role="dialog"]')?.textContent.includes(${JSON.stringify(title("Call the printer"))}) === true`,
    );
    await browser("press", "Escape");
    await browser("wait", "--fn", `document.querySelector('[role="dialog"]') == null`);

    // The keyboard: Left folds Ship, Right unfolds it, Down moves to Copy, Enter opens it.
    await evaluate(`(${row("Ship the site")}.focus(), true)`);
    await browser("press", "ArrowLeft");
    await browser(
      "wait",
      "--fn",
      `${row("Ship the site")}.getAttribute("aria-expanded") === "false"`,
    );
    expect(await evaluate<boolean>(`${row("Write the copy")} == null`)).toBe(true);
    await browser("press", "ArrowRight");
    await browser("wait", "--fn", `${row("Write the copy")} != null`);
    await browser("press", "ArrowDown");
    await browser("wait", "--fn", `document.activeElement === ${row("Write the copy")}`);
    await browser("press", "Enter");
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[role="dialog"]')?.textContent.includes(${JSON.stringify(title("Write the copy"))}) === true`,
    );
    await browser("press", "Escape");
    await browser("wait", "--fn", `document.querySelector('[role="dialog"]') == null`);

    // A status pick keeps Review (in progress) under its ancestors, read as outside the filter.
    await inSite({ operation: "claim", number: review.number });
    await browser("open", `${listPage}&status=in_progress`);
    await browser("wait", "--fn", `${pageHydrated} && ${row("Review the copy")} != null`);
    expect(await attr("Ship the site", "aria-label")).toContain("不在筛选结果里");
    expect(await attr("Review the copy", "aria-label")).not.toContain("不在筛选结果里");
    expect(await evaluate<boolean>(`${row("Buy the domain")} == null`)).toBe(true);
    await shoot("desktop-tree-filtered");

    // A channel pick keeps that channel's Tasks, and says so in a chip.
    await browser("open", `${listPage}&channels=${ops.id}`);
    await browser("wait", "--fn", `${pageHydrated} && ${row("Set up monitoring")} != null`);
    expect(await evaluate<boolean>(`${row("Ship the site")} == null`)).toBe(true);
    expect(await evaluate<boolean>(`document.body.textContent.includes("频道是")`)).toBe(true);
    // The pick is the tree's alone: the board, from the same address, filters by no channel.
    await browser(
      "open",
      `${origin}/zh-CN/w/${workspace.slug}/projects/${home.slug}?tab=tasks&layout=board&channels=${ops.id}`,
    );
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.body.textContent.includes(${JSON.stringify(title("Ship the site"))})`,
    );
    expect(await evaluate<boolean>(`document.body.textContent.includes("频道是")`)).toBe(false);

    // A new sub-task shows without a reload.
    await browser("open", listPage);
    await browser("wait", "--fn", `${pageHydrated} && ${row("Ship the site")} != null`);
    await inSite({
      operation: "create",
      title: title("Test the forms"),
      parent: { number: ship.number },
    });
    await browser("wait", "--fn", `${row("Test the forms")}?.getAttribute("aria-level") === "2"`);

    // A phone opens the Tasks tab on the tree, its list layout.
    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}/zh-CN/w/${workspace.slug}/projects/${home.slug}?tab=tasks`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && ${tree} != null && ${row("Review the copy")} != null`,
    );
    expect(
      await evaluate<boolean>(
        `document.documentElement.scrollWidth <= document.documentElement.clientWidth`,
      ),
    ).toBe(true);
    await shoot("phone-tree");
  } finally {
    await browser("close").catch(() => undefined);
    proxy.stop();
    await experiments.write(workspaceId, "taskConversations", before).catch(() => undefined);
    await db.conversation
      .deleteMany({ where: { id: { in: [site.id, ops.id, closed.id, direct.id] } } })
      .catch(() => undefined);
    await db.project
      .deleteMany({ where: { id: { in: [home.id, other.id] } } })
      .catch(() => undefined);
    await db.workspaceMembership.deleteMany({ where: { userId: lin.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: lin.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 240_000);

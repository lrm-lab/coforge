import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * A Task popup opened from another's is a step down from it (task #464): a sub-task in another
 * channel opens with a back arrow and its parent above its title; Esc, like the arrow, steps back
 * up to the parent's popup, and only there does Esc close. The properties sit beside the pages on a
 * wide screen and under the title on a phone.
 *
 * Opt-in like the other browser E2Es: real local Web started with the `task-conversations` flag
 * file (`/tmp/coforge-flags-tc.json`, read here too), and `agent-browser`. The channels, the Agent
 * and the Tasks are seeded per run and removed after it. Screenshots, light, dark and a phone, are
 * written under `.amp/e2e/task-popup/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/task-popup");

test("a Task popup opened from another steps back to it", async () => {
  // The server under test runs with the same file (COFORGE_FEATURE_FLAGS_FILE).
  await installFeatureFlags(
    await readFeatureFlagsConfiguration({
      COFORGE_FEATURE_FLAGS_FILE: "/tmp/coforge-flags-tc.json",
    }),
  );
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `task-popup-${process.pid}`);
  const board = new TaskBoard(db);
  const experiments = new PrismaExperimentsRepository(db);
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const as = { workspaceId, userId: DEV_BROWSER_USER.id };
  for (const name of ["task-deps", "web-launch"])
    if (await db.conversation.findFirst({ where: { workspaceId, channelName: name } }))
      throw new Error(`#${name} exists`);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: "dax",
      displayName: "Dax",
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
  const channel = (name: string) =>
    db.conversation.create({
      data: {
        workspaceId,
        channelName: name,
        description: "",
        members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
      },
    });
  const deps = await channel("task-deps");
  const launch = await channel("web-launch");
  const run = (conversationId: string, command: Record<string, unknown>) =>
    board.execute(as, {
      idempotencyKey: crypto.randomUUID(),
      conversationId,
      ...command,
    } as Parameters<TaskBoard["execute"]>[1]);
  const before = (await experiments.read(workspaceId)).taskConversations;
  try {
    await experiments.write(workspaceId, "taskConversations", true);
    const parent = (
      await run(deps.id, {
        operation: "create",
        title:
          "项目任务视图：任务可挂到项目（群关联了就默认挂上），项目页按“主需求 → 子需求”列出所有群里的任务和前置关系",
        description:
          "让人在项目页一眼看到一个需求拆成了哪些任务、分别在哪个群、谁在做、卡在哪一步。\n\n第一步先定设计（表结构、读接口、权限），第二步服务端和命令行，第三步项目页的任务树界面。",
      })
    ).tasks[0]!.number;
    const [first, second, third] = (
      await run(launch.id, {
        operation: "create",
        titles: [
          "设计：任务挂项目、项目页读接口、权限",
          "服务端和命令行实现",
          "项目页的任务树界面",
        ],
        parent: { number: parent, channel: "task-deps" },
      })
    ).tasks.map((task) => task.number);
    await run(launch.id, { operation: "amend", number: second, blockedBy: [{ number: first! }] });
    await run(launch.id, {
      operation: "amend",
      number: second,
      description: "按第一步定下的表结构实现读接口，命令行加 `coforge task list --project`。",
    });
    await run(launch.id, { operation: "amend", number: third, blockedBy: [{ number: second! }] });
    await run(launch.id, { operation: "assign", number: first, assignee: "@dax" });
    await run(launch.id, { operation: "claim", numbers: [first] }).catch(() => undefined);
    await run(deps.id, { operation: "assign", number: parent, assignee: "@dax" });

    const settled = () =>
      browser("wait", "--fn", `document.getAnimations().every((a) => a.playState !== "running")`);
    const dialog = `document.querySelector('[role="dialog"]')`;
    const heading = (text: string) =>
      `${dialog}?.querySelector("h2")?.textContent.includes(${JSON.stringify(text)})`;
    const shoot = async (name: string) => {
      await settled();
      await browser("screenshot", join(artifacts, `${name}.png`));
      await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
      await settled();
      await browser("screenshot", join(artifacts, `${name}-dark.png`));
      await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
      await settled();
    };
    const press = async (text: string, within = dialog) => {
      await evaluate(
        `[...${within}.querySelectorAll("button, [role=button], [role=tab], [role=row]")].find((el) => el.textContent.includes(${JSON.stringify(text)}))?.setAttribute("data-e2e-press", "") ?? true`,
      );
      await browser("click", "[data-e2e-press]");
      await evaluate(
        `document.querySelectorAll("[data-e2e-press]").forEach((el) => el.removeAttribute("data-e2e-press")) ?? true`,
      );
    };
    const intoSubtask = async () => {
      await press("子任务");
      await browser("wait", "--fn", `${dialog}.textContent.includes("服务端和命令行实现")`);
      await press("服务端和命令行实现");
      await browser(
        "wait",
        "--fn",
        `location.pathname.endsWith("/channel/${launch.id}") && ${heading("服务端和命令行实现")}`,
      );
    };
    const atParent = `location.pathname.endsWith("/channel/${deps.id}") && ${heading("项目任务视图")}`;
    await mkdir(artifacts, { recursive: true });
    const parentPage = `${origin}/zh-CN/w/${workspace.slug}/channel/${deps.id}?task=${parent}`;

    for (const [width, height, label] of [
      [1280, 860, "desktop"],
      [390, 844, "phone"],
    ] as const) {
      await browser("set", "viewport", String(width), String(height));
      await browser("open", parentPage);
      await browser("wait", "--fn", `${pageHydrated} && ${heading("项目任务视图")}`);
      // Opened afresh, the popup has no way back: it is the first step.
      expect(await evaluate<boolean>(`${dialog}.querySelector("nav button") === null`)).toBe(true);
      await shoot(`${label}-parent`);

      await intoSubtask();
      await shoot(`${label}-subtask`);
      // Esc steps back up to the parent's popup, which Esc then closes; with focus on the dialog
      // itself too, where it lands when a step opens (task #472).
      await evaluate(`${dialog}.focus() ?? true`);
      await browser("press", "Escape");
      await browser("wait", "--fn", atParent);
      await browser("press", "Escape");
      await browser("wait", "--fn", `${dialog} === null`);

      // The back arrow steps back the same way.
      await browser("open", parentPage);
      await browser("wait", "--fn", `${pageHydrated} && ${heading("项目任务视图")}`);
      await intoSubtask();
      await evaluate(
        `${dialog}.querySelector("nav button").setAttribute("data-e2e-back", "") ?? true`,
      );
      await browser("click", "[data-e2e-back]");
      await browser("wait", "--fn", atParent);
    }
  } finally {
    await browser("close").catch(() => undefined);
    await experiments
      .write(workspaceId, "taskConversations", before === true)
      .catch(() => undefined);
    await db.conversation
      .deleteMany({ where: { id: { in: [deps.id, launch.id] } } })
      .catch(() => undefined);
    await db.agentMessageDelivery
      .deleteMany({ where: { agentId: agent.id } })
      .catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 300_000);

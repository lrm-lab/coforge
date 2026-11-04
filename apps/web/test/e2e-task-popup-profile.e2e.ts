import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { getMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { TaskConversations } from "#src/server/tasks/task-conversations.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * A profile opened from inside a Task popup opens over it, not under it in the channel's side slot
 * (Frank, 11-04, task #519): it takes presses, and Escape or a press outside closes it before the
 * popup. Opt-in like the other browser E2Es; the channel, Agent and Task are seeded per run and
 * removed after it. Screenshots go under `.amp/e2e/task-popup-profile/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/task-popup-profile");

test("a profile opened in a Task popup opens over the popup", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `task-popup-profile-${process.pid}`);
  const experiments = new PrismaExperimentsRepository(db);
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const before = (await experiments.read(workspaceId)).taskConversations;
  const tail = `${process.pid}-${Date.now()}`.slice(-5);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-activity-task-${tail}`,
      displayName: `Task Agent ${tail}`,
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
      channelName: `e2e-activity-task-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
    },
  });
  try {
    await experiments.write(workspaceId, "taskConversations", true);
    const created = await new TaskBoard(db).execute({ workspaceId, userId: DEV_BROWSER_USER.id }, {
      idempotencyKey: crypto.randomUUID(),
      conversationId: channel.id,
      operation: "create",
      titles: [`Check the sign-up flow ${tail}`],
    } as Parameters<TaskBoard["execute"]>[1]);
    const number = created.tasks[0]!.number;
    const centrifugo = createCentrifugoServerApi();
    const conversations = new TaskConversations(
      {
        db,
        reader: "agent",
        dependencies: {
          publisher: centrifugo,
          realtime: new CentrifugoConversationRealtime(centrifugo),
        },
      },
      getMessageRequestIdempotency(),
    );
    await conversations.reply(
      { workspaceId, agentId: agent.id },
      { target: `#${channel.channelName}`, number },
      { idempotencyKey: crypto.randomUUID(), body: `The sign-up flow works ${tail}`, mentions: [] },
    );

    await mkdir(artifacts, { recursive: true });
    const dialogs = `[...document.querySelectorAll('[role="dialog"]')]`;
    const profileButton = `[role="dialog"] button[aria-label=${JSON.stringify(`Open Task Agent ${tail}'s profile`)}]`;
    const openProfile = async () => {
      await browser(
        "wait",
        "--fn",
        `document.querySelector(${JSON.stringify(profileButton)}) != null`,
      );
      await browser("click", profileButton);
      // The profile is the newest dialog, over the popup.
      await browser(
        "wait",
        "--fn",
        `${dialogs}.length === 2 && (${dialogs}.at(-1).textContent ?? "").includes("Task Agent ${tail}")`,
      );
      await browser("wait", "500");
    };
    // Nothing covers the profile: what a press lands on, across its whole width, is the profile.
    const profileOnTop = `(() => { const panel = ${dialogs}.at(-1); const r = panel.getBoundingClientRect(); return [0.1, 0.5, 0.9].every((x) => panel.contains(document.elementFromPoint(r.left + r.width * x, r.top + r.height / 2))); })()`;
    // A press inside it works: its tabs switch.
    const pressProfileTab = async () => {
      await evaluate(
        `(${dialogs}.at(-1).querySelectorAll('[role="tab"]')[1].setAttribute("data-e2e-profile-tab", ""), true)`,
      );
      await browser("click", "[data-e2e-profile-tab]");
      await browser(
        "wait",
        "--fn",
        `document.querySelector("[data-e2e-profile-tab]")?.getAttribute("aria-selected") === "true"`,
      );
    };
    const shoot = async (name: string) => {
      await browser("screenshot", join(artifacts, `${name}.png`));
      await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
      await browser("wait", "300");
      await browser("screenshot", join(artifacts, `${name}-dark.png`));
      await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    };
    const popupShowsReply = `${dialogs}.some((el) => (el.textContent ?? "").includes(${JSON.stringify(`sign-up flow works ${tail}`)}))`;

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}?task=${number}`);
    await browser("wait", "--fn", `${pageHydrated} && ${popupShowsReply}`);
    await browser("mouse", "move", "10", "10");
    await openProfile();
    expect(await evaluate<boolean>(profileOnTop)).toBe(true);
    await shoot("desktop");
    await pressProfileTab();

    // Escape closes the profile first, the popup second.
    await browser("press", "Escape");
    await browser("wait", "--fn", `${dialogs}.length === 1`);
    expect(await evaluate<boolean>(popupShowsReply)).toBe(true);
    // Focus is back in the popup, which takes the next Escape.
    expect(await evaluate<boolean>(`${dialogs}[0].contains(document.activeElement)`)).toBe(true);
    await browser("press", "Escape");
    await browser("wait", "--fn", `${dialogs}.length === 0`);

    // A press outside the profile closes only the profile.
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}?task=${number}`);
    await browser("wait", "--fn", `${pageHydrated} && ${popupShowsReply}`);
    await browser("mouse", "move", "10", "10");
    await openProfile();
    await browser("mouse", "move", "40", "450");
    await browser("mouse", "down");
    await browser("mouse", "up");
    await browser("wait", "--fn", `${dialogs}.length === 1`);
    expect(await evaluate<boolean>(popupShowsReply)).toBe(true);

    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}?task=${number}`);
    await browser("wait", "--fn", `${pageHydrated} && ${popupShowsReply}`);
    await openProfile();
    expect(await evaluate<boolean>(profileOnTop)).toBe(true);
    await shoot("phone");
  } finally {
    await experiments.write(workspaceId, "taskConversations", before === true).catch(() => {});
    await browser("close").catch(() => undefined);
    await db.message
      .deleteMany({ where: { sender: { agentId: agent.id } } })
      .catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);

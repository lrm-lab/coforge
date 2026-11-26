import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { getMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { TaskConversations } from "#src/server/tasks/task-conversations.server";
import { CARD_OPEN_DELAY_MS } from "#src/lib/hover-intent";
import {
  animationsSettled,
  browserSession,
  devBrowserWorkspace,
  elementAtRest,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";
import {
  nonTaskDialogs,
  taskDetail,
  taskDetailChildSelector,
  taskDetailPanels,
  taskDetailSheetEntered,
} from "./helpers/task-detail-e2e";

/**
 * A profile opened from inside a Task opens in an inline split pane beside the task on desktop
 * and as a full-screen overlay dialog on a phone: it takes presses, Escape or its Close button
 * dismisses it before the task detail, and focus returns to the triggering control. Opt-in like
 * the other browser E2Es; the channel, Agent and Task are seeded per run and removed after it.
 * Screenshots go under `.artifacts/e2e/task-popup-profile/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/task-popup-profile");

test("a profile opened in a Task popup opens over the popup", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `task-popup-profile-${process.pid}`);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
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
    const dialog = taskDetail;
    const profileDialogs = nonTaskDialogs(true);
    const desktopProfile = '[data-split-slot="profile"]';
    const profileEl = (phone: boolean) =>
      phone
        ? `${profileDialogs}.at(-1)`
        : `document.querySelector(${JSON.stringify(desktopProfile)})`;
    const profileButton = taskDetailChildSelector(
      `button[aria-label=${JSON.stringify(`Open Task Agent ${tail}'s profile`)}]`,
    );
    const onAvatar = `document.activeElement === document.querySelector(${JSON.stringify(profileButton)})`;
    const settled = `${taskDetailSheetEntered} && ${animationsSettled()}`;
    const openProfile = async (phone = false) => {
      await browser(
        "wait",
        "--fn",
        `${elementAtRest(`document.querySelector(${JSON.stringify(profileButton)})`)} && ${settled}`,
      );
      await browser("click", profileButton);
      await browser(
        "wait",
        "--fn",
        `${taskDetailPanels}.length === 1 && (${profileEl(phone)}) != null && ((${profileEl(phone)}).textContent ?? "").includes("Task Agent ${tail}")${phone ? ` && ${profileDialogs}.length === 1` : ""}`,
      );
      await browser("wait", "500");
    };
    const profileOnTop = (phone = false) =>
      `(() => { const panel = ${profileEl(phone)}; if (!panel) return false; const r = panel.getBoundingClientRect(); return [0.1, 0.5, 0.9].every((x) => panel.contains(document.elementFromPoint(r.left + r.width * x, r.top + r.height / 2))); })()`;
    const pressProfileTab = async (phone = false) => {
      const secondTab = `(${profileEl(phone)})?.querySelectorAll('[role="tab"]')[1]`;
      await browser(
        "wait",
        "--fn",
        `${secondTab} != null && ${elementAtRest(secondTab)} && ${animationsSettled()}`,
      );
      await evaluate(`(${secondTab}.setAttribute("data-e2e-profile-tab", ""), true)`);
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
    const popupShowsReply = `${taskDetailPanels}.some((el) => (el.textContent ?? "").includes(${JSON.stringify(`sign-up flow works ${tail}`)}))`;

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}?task=${number}`);
    await browser("wait", "--fn", `${pageHydrated} && ${popupShowsReply}`);
    await browser("mouse", "move", "10", "10");
    await openProfile(false);
    expect(await evaluate<boolean>(profileOnTop(false))).toBe(true);
    await shoot("desktop");
    await pressProfileTab(false);

    await browser("press", "Escape");
    await browser(
      "wait",
      "--fn",
      `document.querySelector(${JSON.stringify(desktopProfile)}) === null`,
    );
    expect(await evaluate<boolean>(popupShowsReply)).toBe(true);
    expect(await evaluate<boolean>(onAvatar)).toBe(true);
    await browser("press", "Escape");
    await browser("wait", "--fn", `${dialog} === null`);

    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}?task=${number}`);
    await browser("wait", "--fn", `${pageHydrated} && ${popupShowsReply}`);
    await browser("mouse", "move", "10", "10");
    await openProfile(false);
    await browser("click", `${desktopProfile} button[aria-label="Close"]`);
    await browser(
      "wait",
      "--fn",
      `document.querySelector(${JSON.stringify(desktopProfile)}) === null`,
    );
    expect(await evaluate<boolean>(popupShowsReply)).toBe(true);
    expect(await evaluate<boolean>(onAvatar)).toBe(true);

    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}?task=${number}`);
    await browser("wait", "--fn", `${pageHydrated} && ${popupShowsReply}`);
    await evaluate(`(${dialog}?.querySelector("[data-task-detail-heading]")?.focus(), true)`);
    for (let tabs = 0; tabs < 60 && !(await evaluate<boolean>(onAvatar)); tabs++)
      await browser("press", "Tab");
    expect(await evaluate<boolean>(onAvatar)).toBe(true);
    const peekOpen = `document.activeElement?.getAttribute("aria-expanded") === "true"`;
    await browser("wait", "--fn", peekOpen);
    await browser("press", "Escape");
    await browser(
      "wait",
      "--fn",
      `!(${peekOpen}) && document.querySelector(${JSON.stringify(desktopProfile)}) === null && ${dialog} != null`,
    );
    expect(await evaluate<boolean>(popupShowsReply)).toBe(true);
    expect(await evaluate<boolean>(onAvatar)).toBe(true);
    await browser("press", "Enter");
    await browser(
      "wait",
      "--fn",
      `${taskDetailPanels}.length === 1 && (${profileEl(false)}) != null && ((${profileEl(false)}).textContent ?? "").includes("Task Agent ${tail}")`,
    );
    await pressProfileTab(false);
    expect(await evaluate<boolean>(onAvatar)).toBe(false);
    expect(await evaluate<boolean>(`${profileEl(false)}.contains(document.activeElement)`)).toBe(
      true,
    );
    await browser("press", "Escape");
    await browser(
      "wait",
      "--fn",
      `document.querySelector(${JSON.stringify(desktopProfile)}) === null`,
    );
    expect(await evaluate<boolean>(popupShowsReply)).toBe(true);
    expect(await evaluate<boolean>(onAvatar)).toBe(true);
    await browser("wait", String(CARD_OPEN_DELAY_MS + 150));
    expect(await evaluate<boolean>(onAvatar)).toBe(true);
    expect(
      await evaluate<string | null>(
        `document.querySelector(${JSON.stringify(profileButton)})?.getAttribute("aria-expanded")`,
      ),
    ).toBe("false");
    expect(
      await evaluate<boolean>(`document.querySelector(${JSON.stringify(desktopProfile)}) === null`),
    ).toBe(true);
    await browser("press", "Escape");
    await browser("wait", "--fn", `${dialog} === null`);

    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}?task=${number}`);
    await browser("wait", "--fn", `${pageHydrated} && ${popupShowsReply}`);
    await browser("mouse", "move", "10", "10");
    await openProfile(true);
    expect(await evaluate<boolean>(profileOnTop(true))).toBe(true);
    await shoot("phone");
    await browser("press", "Escape");
    await browser("wait", "--fn", `${profileDialogs}.length === 0`);
    expect(await evaluate<boolean>(popupShowsReply)).toBe(true);
    expect(await evaluate<boolean>(onAvatar)).toBe(true);
  } finally {
    await browser("close").catch(() => undefined);
    await db.message
      .deleteMany({ where: { sender: { agentId: agent.id } } })
      .catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);

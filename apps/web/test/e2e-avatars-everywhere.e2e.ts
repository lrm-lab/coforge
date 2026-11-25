import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import {
  animationsSettled,
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";
import { taskDetailSheetEntered, topTaskDetail } from "./helpers/task-detail-e2e";

const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/avatars-everywhere");

test("names carry their faces", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `avatars-everywhere-${process.pid}`);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const tail = `${process.pid}-${Date.now()}`.slice(-5);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-faces-${tail}`,
      displayName: `Faces Agent ${tail}`,
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
      channelName: `e2e-faces-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
    },
  });
  const cleanup: string[] = [channel.id];
  try {
    const board = new TaskBoard(db);
    const run = (command: Record<string, unknown>) =>
      board.execute({ workspaceId, userId: DEV_BROWSER_USER.id }, {
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        ...command,
      } as Parameters<TaskBoard["execute"]>[1]);
    const number = (await run({ operation: "create", titles: [`Check the sign-up flow ${tail}`] }))
      .tasks[0]!.number;
    await run({ operation: "assign", number, assignee: `@${agent.name}` });

    await mkdir(artifacts, { recursive: true });
    const shoot = async (name: string) => {
      await browser("screenshot", join(artifacts, `${name}.png`));
      await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
      await browser("wait", "300");
      await browser("screenshot", join(artifacts, `${name}-dark.png`));
      await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    };
    const dialog = topTaskDetail;
    const openHistory = async () => {
      await browser(
        "open",
        `${origin}/en/w/${workspace.slug}/channel/${channel.id}?task=${number}`,
      );
      const actions = `${dialog}?.querySelector('button[aria-label="More actions for task #${number}"]')`;
      await browser(
        "wait",
        "--fn",
        `${pageHydrated} && ${taskDetailSheetEntered} && ${animationsSettled()} && ${actions} != null`,
      );
      await evaluate(`(${actions}.setAttribute("data-e2e-actions", ""), true)`);
      await browser("click", "[data-e2e-actions]");
      const fullHistory = `[...document.querySelectorAll('[role^="menuitem"]')].find((el) => el.textContent.trim() === "View full history")`;
      await browser("wait", "--fn", `${fullHistory} != null`);
      await evaluate(`(${fullHistory}.setAttribute("data-e2e-history", ""), true)`);
      await browser("click", "[data-e2e-history]");
      await browser("wait", "--fn", `${dialog}.textContent.includes("Owner: ")`);
      await browser("wait", "500");
    };

    await browser("set", "viewport", "1280", "900");
    await openHistory();
    await shoot("history");
    const history = `${dialog}.querySelector("ol")`;
    expect(
      await evaluate<number>(`${history}.querySelectorAll("img").length`),
    ).toBeGreaterThanOrEqual(3);
    await browser(
      "wait",
      "--fn",
      `[...document.querySelectorAll("img[data-avatar-img]")].every((img) => img.complete)`,
    );
    await browser("wait", "300");
    expect(
      await evaluate<string[]>(
        `[...document.querySelectorAll("img[data-avatar-img]")].filter((img) => img.naturalWidth > 0).map((img) => getComputedStyle(img.parentElement).backgroundColor).filter((color) => color !== "rgba(0, 0, 0, 0)")`,
      ),
    ).toEqual([]);
    await browser("set", "viewport", "390", "844");
    await openHistory();
    await shoot("history-phone");

    await browser("set", "viewport", "1280", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}?task=${number}`);
    const discussionNotice = `${dialog}?.querySelector('[data-message="system"]')`;
    const fold = `[...(${dialog}?.querySelectorAll("button") ?? [])].find((b) => /task updates?$/.test(b.textContent.trim()))`;
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && (${discussionNotice} != null || ${fold} != null)`,
    );
    if (await evaluate<boolean>(`${discussionNotice} == null`)) {
      await evaluate(`(${fold}.setAttribute("data-e2e-fold", ""), true)`);
      await browser("click", "[data-e2e-fold]");
      await browser("wait", "--fn", `${discussionNotice} != null`);
    }
    await browser("wait", "500");
    const assigned = `[...${dialog}.querySelectorAll('[data-message="system"]')].find((row) => row.textContent.includes(${JSON.stringify(agent.name)}))`;
    expect(await evaluate<number>(`${assigned}.querySelectorAll("img").length`)).toBe(2);
    await shoot("task-discussion");

    const notices = await db.conversation.create({
      data: {
        workspaceId,
        channelName: `e2e-faces-notice-${tail}`,
        description: "",
        members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
      },
    });
    cleanup.push(notices.id);
    await db.conversation.update({ where: { id: notices.id }, data: { lastSequence: 1 } });
    const notice = await db.message.create({
      data: {
        workspaceId,
        conversationId: notices.id,
        sequence: 1,
        senderMemberId: null,
        body: `${DEV_BROWSER_USER.username} added @${agent.name} to this channel.`,
      },
    });
    await db.systemMessage.create({
      data: {
        messageId: notice.id,
        conversationId: notices.id,
        workspaceId,
        kind: "channel.member_added",
        params: {
          actor: { memberId: null, handle: DEV_BROWSER_USER.username, displayName: "Dev User" },
          members: [
            { memberId: null, handle: agent.name, displayName: agent.displayName, kind: "agent" },
          ],
        },
      },
    });
    const [meIn, agentIn] = await Promise.all([
      db.conversationMember.findFirstOrThrow({
        where: { conversationId: notices.id, userId: DEV_BROWSER_USER.id },
      }),
      db.conversationMember.findFirstOrThrow({
        where: { conversationId: notices.id, agentId: agent.id },
      }),
    ]);
    const pinged = await db.message.create({
      data: {
        workspaceId,
        conversationId: notices.id,
        sequence: 2,
        senderMemberId: meIn.id,
        body: `Can @${agent.name} pair with @${DEV_BROWSER_USER.username} on this?`,
      },
    });
    const renamed = await db.message.create({
      data: {
        workspaceId,
        conversationId: notices.id,
        sequence: 3,
        senderMemberId: null,
        body: "old-agent-name moved #1 to Done",
      },
    });
    await db.systemMessage.create({
      data: {
        messageId: renamed.id,
        conversationId: notices.id,
        workspaceId,
        kind: "channel.member_added",
        params: {
          actor: { memberId: agentIn.id, handle: `old-${agent.name}`, displayName: "Old name" },
          members: [{ memberId: null, handle: "gone-person", displayName: "Gone Person" }],
        },
      },
    });
    await db.conversation.update({ where: { id: notices.id }, data: { lastSequence: 3 } });
    for (const [member, kind, actorId, handle] of [
      [agentIn.id, "agent", agent.id, agent.name],
      [meIn.id, "user", DEV_BROWSER_USER.id, DEV_BROWSER_USER.username],
    ] as const)
      await db.messageMention.create({
        data: {
          messageId: pinged.id,
          memberId: member,
          conversationId: notices.id,
          workspaceId,
          kind,
          actorId,
          handle,
        },
      });
    const chips = `document.querySelectorAll('[data-message-id="${pinged.id}"] .message-markdown-mention')`;
    const noticeRow = `document.querySelector('[data-message-id="${notice.id}"] [data-message="system"]')`;
    for (const [width, height, name] of [
      ["1280", "900", "notice"],
      ["390", "844", "notice-phone"],
    ] as const) {
      await browser("set", "viewport", width, height);
      await browser("open", `${origin}/en/w/${workspace.slug}/channel/${notices.id}`);
      await browser("wait", "--fn", `${pageHydrated} && ${noticeRow} != null`);
      await browser("wait", "500");
      expect(await evaluate<number>(`${noticeRow}.querySelectorAll("img").length`)).toBe(2);
      expect(await evaluate<boolean>(`${noticeRow}.textContent.includes("@")`)).toBe(false);
      expect(
        await evaluate<number>(`[...${chips}].filter((chip) => chip.querySelector("img")).length`),
      ).toBe(0);
      expect(
        await evaluate<boolean>(
          `[...${chips}].every((chip) => chip.textContent.trim().startsWith("@"))`,
        ),
      ).toBe(true);
      expect(await evaluate<number>(`${chips}.length`)).toBe(2);
      const renamedRow = `document.querySelector('[data-message-id="${renamed.id}"] [data-message="system"]')`;
      expect(await evaluate<number>(`${renamedRow}.querySelectorAll("img").length`)).toBe(1);
      expect(
        await evaluate<string>(
          `getComputedStyle(${renamedRow}.querySelector("[data-avatar] > div:not(:has(img))")).backgroundColor`,
        ),
      ).not.toBe("rgba(0, 0, 0, 0)");
      await shoot(name);
    }
    const root = await db.message.create({
      data: {
        workspaceId,
        conversationId: notices.id,
        sequence: 4,
        senderMemberId: meIn.id,
        body: "Can someone take this?",
      },
    });
    const threaded = await db.message.create({
      data: {
        workspaceId,
        conversationId: notices.id,
        sequence: 5,
        senderMemberId: null,
        threadRootId: root.id,
        body: `${agent.name} added ${DEV_BROWSER_USER.username} to this channel.`,
      },
    });
    await db.systemMessage.create({
      data: {
        messageId: threaded.id,
        conversationId: notices.id,
        workspaceId,
        kind: "channel.member_added",
        params: {
          actor: { memberId: agentIn.id, handle: agent.name, displayName: agent.displayName },
          members: [
            { memberId: meIn.id, handle: DEV_BROWSER_USER.username, displayName: "Dev User" },
          ],
        },
      },
    });
    await db.message.create({
      data: {
        workspaceId,
        conversationId: notices.id,
        sequence: 6,
        senderMemberId: agentIn.id,
        threadRootId: root.id,
        body: "On it.",
      },
    });
    await db.conversation.update({ where: { id: notices.id }, data: { lastSequence: 6 } });
    const threadNotice = `document.querySelector('section [data-message-id="${threaded.id}"] [data-message="system"]')`;
    await browser("set", "viewport", "1280", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${notices.id}`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.querySelector('[data-message-id="${root.id}"] [data-thread-preview]') != null`,
    );
    await evaluate(
      `document.querySelector('[data-message-id="${root.id}"] [data-thread-preview]').click() ?? true`,
    );
    await browser("wait", "--fn", `${threadNotice} != null`);
    await browser("wait", "500");
    expect(await evaluate<number>(`${threadNotice}.querySelectorAll("img").length`)).toBe(2);
    await shoot("thread-notice");
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: { in: cleanup } } }).catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);

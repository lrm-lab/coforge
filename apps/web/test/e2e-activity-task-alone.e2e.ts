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
 * A Task's discussion card on Activity opens the Task's popup alone, over Activity, not its
 * channel's chat behind it (Frank, 11-04, #task_v2). Opt-in like the other browser E2Es; the
 * channel, Agent and Task are seeded per run and removed after it. Screenshots go under
 * `.amp/e2e/activity-task-alone/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/activity-task-alone");

test("a Task card on Activity opens the Task's popup, not its channel's chat", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `activity-task-${process.pid}`);
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
  // A message of the channel's own: its chat must not open behind the popup.
  const chatLine = `Channel chat line ${tail}`;
  try {
    await experiments.write(workspaceId, "taskConversations", true);
    const me = await db.conversationMember.findFirstOrThrow({
      where: { conversationId: channel.id, userId: DEV_BROWSER_USER.id },
    });
    await db.message.create({
      data: {
        workspaceId,
        conversationId: channel.id,
        sequence: 1,
        // The Agent's, so it is unread: opening the Task must leave it so.
        senderMemberId: (
          await db.conversationMember.findFirstOrThrow({
            where: { conversationId: channel.id, agentId: agent.id },
          })
        ).id,
        body: chatLine,
      },
    });
    await db.conversation.update({ where: { id: channel.id }, data: { lastSequence: 1 } });
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
    // More replies than the popup shows at once, all unread: it opens at the first of them, not
    // at the newest.
    for (let index = 1; index <= 30; index++)
      await conversations.reply(
        { workspaceId, agentId: agent.id },
        { target: `#${channel.channelName}`, number },
        {
          idempotencyKey: crypto.randomUUID(),
          body:
            index === 1
              ? `@${DEV_BROWSER_USER.username} the sign-up flow works ${tail}`
              : `Step ${index} checked`,
          mentions: [],
        },
      );
    const firstReply = await db.message.findFirstOrThrow({
      where: { sender: { agentId: agent.id }, body: { contains: "sign-up flow works" } },
      select: { id: true },
    });

    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}/activity`);
    const row = `[...document.querySelectorAll("[data-activity-list] a")].find((el) => el.textContent.includes(${JSON.stringify(`Check the sign-up flow ${tail}`)}))`;
    await browser("wait", "--fn", `${pageHydrated} && ${row} != null`);
    await evaluate(`(${row}.setAttribute("data-e2e-task-row", ""), true)`);
    await browser("click", "[data-e2e-task-row]");
    const dialog = `document.querySelector('[role="dialog"]')`;
    await browser(
      "wait",
      "--fn",
      `(${dialog}?.textContent ?? "").includes(${JSON.stringify(`the sign-up flow works ${tail}`)})`,
    );
    // Only the popup: the channel's chat is not behind it, and the address says the Task alone.
    expect(
      await evaluate<number>(
        `[...document.querySelectorAll("[data-message-id]")].filter((el) => !${dialog}.contains(el)).length`,
      ),
    ).toBe(0);
    expect(await evaluate<string>(`new URL(location.href).searchParams.get("open") ?? ""`)).toBe(
      `task:channel:${channel.id}`,
    );
    // It opens at the first unread reply: in view, inside the popup.
    const landing = `document.querySelector('[data-message-id="${firstReply.id}"]')`;
    await browser("wait", "--fn", `${landing} != null`);
    await browser("wait", "500");
    expect(
      await evaluate<boolean>(
        `(() => { const r = ${landing}.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && ${dialog}.contains(${landing}); })()`,
      ),
    ).toBe(true);
    // The channel stays unread: its chat never opened.
    expect(
      (await db.conversationMember.findUniqueOrThrow({ where: { id: me.id } })).readThroughSequence,
    ).toBe(0);
    await browser("screenshot", join(artifacts, "desktop.png"));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await browser("wait", "300");
    await browser("screenshot", join(artifacts, "desktop-dark.png"));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);

    // Closing it goes back to the list.
    await browser("press", "Escape");
    await browser("wait", "--fn", `${dialog} === null`);
    expect(await evaluate<string | null>(`new URL(location.href).searchParams.get("open")`)).toBe(
      null,
    );

    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}/en/w/${workspace.slug}/activity`);
    await browser("wait", "--fn", `${pageHydrated} && ${row} != null`);
    await evaluate(`(${row}.setAttribute("data-e2e-task-row", ""), true)`);
    await browser("click", "[data-e2e-task-row]");
    await browser("wait", "--fn", `(${dialog}?.textContent ?? "").includes("sign-up flow works")`);
    await browser("wait", "500");
    await browser("screenshot", join(artifacts, "phone.png"));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await browser("wait", "300");
    await browser("screenshot", join(artifacts, "phone-dark.png"));
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

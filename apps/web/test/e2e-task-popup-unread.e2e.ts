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
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";

/**
 * A Task popup's discussion opens on the reader's first unread under the "New messages" divider,
 * as a channel does (task #99), and the open moves their read position: the next open has none.
 * Opt-in like the other browser E2Es; the channel, Agent and Task are seeded per run and removed
 * after. Screenshots go under `.amp/e2e/task-popup-unread/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/task-popup-unread");

test("a Task popup's discussion opens on its first unread under a New messages divider", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `task-popup-unread-${process.pid}`);
  const experiments = new PrismaExperimentsRepository(db);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const before = (await experiments.read(workspaceId)).taskConversations;
  const tail = `${process.pid}-${Date.now()}`.slice(-5);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-task-unread-${tail}`,
      displayName: `Unread Agent ${tail}`,
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
      channelName: `e2e-task-unread-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
    },
  });
  const as = { workspaceId, userId: DEV_BROWSER_USER.id };
  try {
    await experiments.write(workspaceId, "taskConversations", true);
    const created = await new TaskBoard(db).execute(as, {
      idempotencyKey: crypto.randomUUID(),
      conversationId: channel.id,
      operation: "create",
      titles: [`Check the sign-up flow ${tail}`],
    } as Parameters<TaskBoard["execute"]>[1]);
    const number = created.tasks[0]!.number;
    const centrifugo = createCentrifugoServerApi();
    const dependencies = {
      publisher: centrifugo,
      realtime: new CentrifugoConversationRealtime(centrifugo),
    };
    const idempotency = getMessageRequestIdempotency();
    const people = new TaskConversations({ db, reader: "people", dependencies }, idempotency);
    const agents = new TaskConversations({ db, reader: "agent", dependencies }, idempotency);
    const ref = { conversationId: channel.id, number };
    const agentSays = (body: string) =>
      agents.reply(
        { workspaceId, agentId: agent.id },
        { target: `#${channel.channelName}`, number },
        { idempotencyKey: crypto.randomUUID(), body, mentions: [] },
      );
    // The reader spoke, so they have a seat and a read position; what the Agent said since is
    // unread, more of it than one page of the discussion holds, so the popup reads further back.
    await people.reply(as, ref, {
      idempotencyKey: crypto.randomUUID(),
      body: `Please check the sign-up flow ${tail}`,
      mentions: [],
    });
    await agentSays(`On it ${tail}`);
    const { conversationId } = await people.open(as, ref);
    const seat = await db.conversationMember.findFirstOrThrow({
      where: { conversationId, userId: DEV_BROWSER_USER.id },
    });
    const sequenceOf = async (body: string) =>
      (
        await db.message.findFirstOrThrow({
          where: { conversationId, body: { contains: body } },
          select: { sequence: true },
        })
      ).sequence;
    await db.conversationMember.update({
      where: { id: seat.id },
      data: { readThroughSequence: await sequenceOf(`On it ${tail}`) },
    });
    await agentSays(`The sign-up flow works ${tail}`);
    for (let index = 2; index <= 60; index++) await agentSays(`Step ${index} checked`);
    const firstUnread = await db.message.findFirstOrThrow({
      where: { conversationId, body: `The sign-up flow works ${tail}` },
      select: { id: true },
    });

    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1280", "860");
    await browser("open", `${origin}/en/w/${workspace.slug}/tasks?task=${channel.id}:${number}`);
    const dialog = `document.querySelector('[role="dialog"]')`;
    const divider = `${dialog}?.querySelector('[role="separator"][aria-label="New messages"]')`;
    const landing = `${dialog}?.querySelector('[data-message-id="${firstUnread.id}"]')`;
    await browser("wait", "--fn", `${pageHydrated} && ${divider} != null && ${landing} != null`);
    await browser("wait", "500");
    // The divider heads the first unread reply's row, and the popup opens on it.
    const placed = await evaluate<string>(
      `(() => { const d = ${divider}.getBoundingClientRect(); const r = ${landing}.getBoundingClientRect(); return JSON.stringify({ inRow: ${landing}.contains(${divider}), d: [d.top, d.bottom], r: [r.top, r.bottom], h: innerHeight }); })()`,
    );
    const { inRow, d, h } = JSON.parse(placed) as { inRow: boolean; d: number[]; h: number };
    expect(inRow).toBe(true);
    expect(d[0]! >= 0 && d[1]! <= h).toBe(true);
    // It starts a sender run, though the Agent also wrote the message above it.
    expect(await evaluate<string>(`${landing}.getAttribute("data-message-row")`)).toBe("divided");
    expect(await evaluate<string>(`${landing}.textContent`)).toContain(`Unread Agent ${tail}`);
    await browser("screenshot", join(artifacts, "desktop.png"));
    // Having opened it, the reader has read it all: their position moved to the newest reply.
    const newest = await sequenceOf("Step 60 checked");
    for (let tries = 0; tries < 50; tries++) {
      const { readThroughSequence } = await db.conversationMember.findUniqueOrThrow({
        where: { id: seat.id },
      });
      if (readThroughSequence === newest) break;
      await Bun.sleep(100);
    }
    expect(
      (await db.conversationMember.findUniqueOrThrow({ where: { id: seat.id } }))
        .readThroughSequence,
    ).toBe(newest);

    // The next open has nothing unread: no divider.
    await browser("press", "Escape");
    await browser("wait", "--fn", `${dialog} === null`);
    await browser("open", `${origin}/en/w/${workspace.slug}/tasks?task=${channel.id}:${number}`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && (${dialog}?.textContent ?? "").includes("Step 60 checked")`,
    );
    await browser("wait", "800");
    expect(await evaluate<boolean>(`${divider} != null`)).toBe(false);
  } finally {
    await experiments.write(workspaceId, "taskConversations", before === true).catch(() => {});
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);

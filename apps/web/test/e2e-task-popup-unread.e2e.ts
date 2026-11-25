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
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";
import { taskDetail } from "./helpers/task-detail-e2e";

/**
 * A Task popup's discussion opens on its oldest replies and leaves the reader's read position where
 * it was; reaching the newest reply, paging forward through the window, moves it. Opt-in like the other browser E2Es; the channel, Agent and Task are seeded per run and removed
 * after. Screenshots go under `.artifacts/e2e/task-popup-unread/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/task-popup-unread");

async function seedTask(steps: number) {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
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
  for (let index = 2; index <= steps; index++) await agentSays(`Step ${index} checked`);

  const cleanup = async () => {
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  };
  return { db, workspace, channel, number, seat, tail, sequenceOf, cleanup };
}

test("a Task popup's discussion opens on its oldest replies and is read on reaching the newest", async () => {
  const { browser, evaluate } = browserSession(browserPath, `task-popup-unread-${process.pid}`);
  const { db, workspace, channel, number, seat, tail, sequenceOf, cleanup } = await seedTask(60);
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1280", "860");
    await browser("open", `${origin}/en/w/${workspace.slug}/tasks?task=${channel.id}:${number}`);
    const dialog = taskDetail;
    const history = `${dialog}?.querySelector('[data-scroll-restoration-id^="conversation-"]')`;
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && (${dialog}?.textContent ?? "").includes("Please check the sign-up flow ${tail}")`,
    );
    await browser("wait", "1500");
    await browser("screenshot", join(artifacts, "desktop.png"));
    expect(await evaluate<number>(`${history}.scrollTop`)).toBe(0);
    expect(
      await evaluate<boolean>(`(${dialog}?.textContent ?? "").includes("60 new messages")`),
    ).toBe(true);
    expect(
      await evaluate<boolean>(`(${dialog}?.textContent ?? "").includes("Step 60 checked")`),
    ).toBe(false);
    expect(
      (await db.conversationMember.findUniqueOrThrow({ where: { id: seat.id } }))
        .readThroughSequence,
    ).toBe(await sequenceOf(`On it ${tail}`));

    const newest = await sequenceOf("Step 60 checked");
    for (let tries = 0; tries < 100; tries++) {
      await evaluate(
        `(() => { const h = ${history}; if (h) h.scrollTop = h.scrollHeight; return true; })()`,
      );
      const { readThroughSequence } = await db.conversationMember.findUniqueOrThrow({
        where: { id: seat.id },
      });
      if (readThroughSequence === newest) break;
      await Bun.sleep(200);
    }
    expect(
      (await db.conversationMember.findUniqueOrThrow({ where: { id: seat.id } }))
        .readThroughSequence,
    ).toBe(newest);
    expect(
      await evaluate<boolean>(`(${dialog}?.textContent ?? "").includes("Step 60 checked")`),
    ).toBe(true);
  } finally {
    await browser("close").catch(() => undefined);
    await cleanup();
  }
}, 180_000);

test("a Task popup whose discussion fits is read once it opens", async () => {
  const { browser } = browserSession(browserPath, `task-popup-fits-${process.pid}`);
  const { db, workspace, channel, number, seat, sequenceOf, cleanup } = await seedTask(2);
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1280", "860");
    await browser("open", `${origin}/en/w/${workspace.slug}/tasks?task=${channel.id}:${number}`);
    const dialog = taskDetail;
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && (${dialog}?.textContent ?? "").includes("Step 2 checked")`,
    );
    const newest = await sequenceOf("Step 2 checked");
    for (let tries = 0; tries < 50; tries++) {
      const { readThroughSequence } = await db.conversationMember.findUniqueOrThrow({
        where: { id: seat.id },
      });
      if (readThroughSequence === newest) break;
      await Bun.sleep(200);
    }
    expect(
      (await db.conversationMember.findUniqueOrThrow({ where: { id: seat.id } }))
        .readThroughSequence,
    ).toBe(newest);
    await browser("wait", "--fn", `!/new messages?/.test(${dialog}?.textContent ?? "")`);
    await browser("screenshot", join(artifacts, "fits.png"));
  } finally {
    await browser("close").catch(() => undefined);
    await cleanup();
  }
}, 120_000);

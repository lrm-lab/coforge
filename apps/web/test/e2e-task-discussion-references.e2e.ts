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
 * A Task's own discussion names other Tasks of its board (Frank, 11-04): in the Tasks page's popup,
 * which has no channel stream behind it, those references show their Task's status and title, not
 * a bare "#N". Opt-in like the other browser E2Es; the channel is seeded per run and removed after.
 * Screenshots go under `.amp/e2e/task-discussion-references/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/task-discussion-references");

test("a Task discussion's references to the board's other Tasks show their titles", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `task-discussion-refs-${process.pid}`);
  const experiments = new PrismaExperimentsRepository(db);
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const before = (await experiments.read(workspaceId)).taskConversations;
  const tail = `${process.pid}-${Date.now()}`.slice(-5);
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-discussion-refs-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }] },
    },
  });
  const as = { workspaceId, userId: DEV_BROWSER_USER.id };
  const board = new TaskBoard(db);
  try {
    await experiments.write(workspaceId, "taskConversations", true);
    const created = await board.execute(as, {
      idempotencyKey: crypto.randomUUID(),
      conversationId: channel.id,
      operation: "create",
      titles: [`Redesign the cards ${tail}`, `Card server format ${tail}`],
    } as Parameters<TaskBoard["execute"]>[1]);
    const [cards, format] = created.tasks.map((task) => task.number) as [number, number];
    const centrifugo = createCentrifugoServerApi();
    const conversations = new TaskConversations(
      {
        db,
        reader: "people",
        dependencies: {
          publisher: centrifugo,
          realtime: new CentrifugoConversationRealtime(centrifugo),
        },
      },
      getMessageRequestIdempotency(),
    );
    await conversations.reply(
      as,
      { conversationId: channel.id, number: cards },
      {
        idempotencyKey: crypto.randomUUID(),
        body: `The server format is <@task:${format}>, design first.`,
        mentions: [],
      },
    );

    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1280", "860");
    await browser("open", `${origin}/en/w/${workspace.slug}/tasks?task=${channel.id}:${cards}`);
    const dialog = `document.querySelector('[role="dialog"]')`;
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && (${dialog}?.textContent ?? "").includes("design first")`,
    );
    // The reference becomes its Task's chip, its title in it, not "#N" alone.
    await browser(
      "wait",
      "--fn",
      `(${dialog}?.textContent ?? "").includes(${JSON.stringify(`Card server format ${tail}`)})`,
    );
    expect(
      await evaluate<boolean>(
        `(${dialog}?.textContent ?? "").includes(${JSON.stringify(`Card server format ${tail}`)})`,
      ),
    ).toBe(true);
    await browser("screenshot", join(artifacts, "desktop-reference.png"));
  } finally {
    await experiments.write(workspaceId, "taskConversations", before === true).catch(() => {});
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);

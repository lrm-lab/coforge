import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";

/**
 * A thread reply that names this channel's Task as written, `#channel:#N` (an Agent's reply keeps
 * the form as typed), shows the Task's chip, as a stored `<@task:N>` does, not a bare "#N" (task
 * #coforge-designer-team:#97). The Tasks were made long before the window, so only the reference reads them.
 * The same holds in the stream, and for another channel's Task written `#other:#N`, which reads
 * as that Task's chip under its channel's name. Screenshots go under `.amp/e2e/thread-written-task-reference/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/thread-written-task-reference");

test("a reply naming this channel's Task as `#channel:#N` shows its chip", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `thread-written-ref-${process.pid}`);
  const experiments = new PrismaExperimentsRepository(db);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const before = (await experiments.read(workspaceId)).taskConversations;
  const tail = `${process.pid}-${Date.now()}`.slice(-5);
  const name = `e2e-written-ref-${tail}`;
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: name,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }] },
    },
  });
  const other = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-written-other-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }] },
    },
  });
  const me = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: channel.id, userId: DEV_BROWSER_USER.id },
  });
  try {
    await experiments.write(workspaceId, "taskConversations", true);
    const made = await new TaskBoard(db).execute({ workspaceId, userId: DEV_BROWSER_USER.id }, {
      idempotencyKey: crypto.randomUUID(),
      conversationId: channel.id,
      operation: "create",
      titles: ["Ship the new homepage", "Archived avatars", "Card outcome line"],
    } as Parameters<TaskBoard["execute"]>[1]);
    const [written, stored, streamed] = made.tasks.map((task) => task.number) as [
      number,
      number,
      number,
    ];
    const [elsewhere] = (
      await new TaskBoard(db).execute({ workspaceId, userId: DEV_BROWSER_USER.id }, {
        idempotencyKey: crypto.randomUUID(),
        conversationId: other.id,
        operation: "create",
        titles: ["Backend rate limits"],
      } as Parameters<TaskBoard["execute"]>[1])
    ).tasks.map((task) => task.number) as [number];
    let sequence = (await db.conversation.findUniqueOrThrow({ where: { id: channel.id } }))
      .lastSequence;
    const say = (body: string, threadRootId: string | null = null) =>
      db.message.create({
        data: {
          workspaceId,
          conversationId: channel.id,
          sequence: ++sequence,
          senderMemberId: me.id,
          body,
          threadRootId,
        },
      });
    // Two windows' worth of chat, so the Tasks' own messages are out of the loaded window.
    for (let index = 0; index < 45; index += 1) await say(`Chat ${index + 1}`);
    const root = await say(`Where is the homepage work? Also #${name}:#${streamed}`);
    const reply = await say(
      `It's filed as #${name}:#${written}, next to <@task:${stored}> and #${other.channelName}:#${elsewhere}.`,
      root.id,
    );
    await db.conversation.update({ where: { id: channel.id }, data: { lastSequence: sequence } });

    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1280", "800");
    await browser(
      "open",
      `${origin}/en/w/${workspace.slug}/channel/${channel.id}?view=chat&threadRootId=${root.id}`,
    );
    const row = (id: string) => `document.querySelector('[data-message-id="${id}"]')`;
    const chips = (id: string) =>
      `[...${row(id)}?.querySelectorAll("[data-task-status]") ?? []].map((chip) => chip.textContent.trim())`;
    await browser("wait", "--fn", `${pageHydrated} && ${row(reply.id)} != null`);
    await browser("wait", "--fn", `${chips(reply.id)}.length === 3`);
    expect(await evaluate<string[]>(chips(reply.id))).toEqual([
      "Ship the new homepage",
      "Archived avatars",
      "Backend rate limits",
    ]);
    // The stream reads the written form of its own channel the same way.
    await browser("wait", "--fn", `${chips(root.id)}.length === 1`);
    expect(await evaluate<string[]>(chips(root.id))).toEqual(["Card outcome line"]);
    await browser("wait", "500");
    await browser("screenshot", join(artifacts, "desktop.png"));
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation
      .deleteMany({ where: { id: { in: [channel.id, other.id] } } })
      .catch(() => undefined);
    await experiments.write(workspaceId, "taskConversations", before).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);

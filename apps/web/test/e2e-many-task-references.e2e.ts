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
 * A channel whose loaded messages name more Tasks than one read takes (task #coforge-ui:#26): an
 * early message names #1 to #220, the newest names #221 to #230. Every one shows as its Task's
 * chip, the newest included, not as a bare number. Opt-in like the other browser E2Es; the channel
 * is seeded per run and removed after it. Screenshots go under `.amp/e2e/many-task-references/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/many-task-references");
const TASKS = 230;

test("a window naming more than 200 Tasks shows each as its chip, the newest too", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `many-task-refs-${process.pid}`);
  const experiments = new PrismaExperimentsRepository(db);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const before = (await experiments.read(workspaceId)).taskConversations;
  const tail = `${process.pid}-${Date.now()}`.slice(-5);
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-many-refs-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }] },
    },
  });
  const me = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: channel.id, userId: DEV_BROWSER_USER.id },
  });
  const board = new TaskBoard(db);
  try {
    await experiments.write(workspaceId, "taskConversations", true);
    const numbers: number[] = [];
    for (let at = 0; at < TASKS; at += 50) {
      const made = await board.execute({ workspaceId, userId: DEV_BROWSER_USER.id }, {
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        operation: "create",
        titles: Array.from({ length: Math.min(50, TASKS - at) }, (_, i) => `Item ${at + i + 1}`),
      } as Parameters<TaskBoard["execute"]>[1]);
      numbers.push(...made.tasks.map((task) => task.number));
    }
    const newest = numbers.slice(220);
    const sequence = (await db.conversation.findUniqueOrThrow({ where: { id: channel.id } }))
      .lastSequence;
    const say = (offset: number, body: string) =>
      db.message.create({
        data: {
          workspaceId,
          conversationId: channel.id,
          sequence: sequence + offset,
          senderMemberId: me.id,
          body,
        },
      });
    await say(
      1,
      numbers
        .slice(0, 220)
        .map((number) => `<@task:${number}>`)
        .join(" "),
    );
    const last = await say(2, `Status: ${newest.map((number) => `<@task:${number}>`).join(", ")}`);
    await db.conversation.update({
      where: { id: channel.id },
      data: { lastSequence: sequence + 2 },
    });

    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1280", "800");
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}?view=chat`);
    const row = `document.querySelector('[data-message-id="${last.id}"]')`;
    await browser("wait", "--fn", `${pageHydrated} && ${row} != null`);
    // Each of the newest references reads as its Task's title, not as a bare number.
    await browser(
      "wait",
      "--fn",
      `${row}.querySelectorAll("[data-task-status]").length === ${newest.length}`,
    );
    const titles = await evaluate<string[]>(
      `[...${row}.querySelectorAll("[data-task-status]")].map((chip) => chip.textContent.trim())`,
    );
    expect(titles).toEqual(newest.map((number) => `Item ${number}`));
    await browser("wait", "500");
    await browser("screenshot", join(artifacts, "desktop.png"));
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.delete({ where: { id: channel.id } }).catch(() => undefined);
    await experiments.write(workspaceId, "taskConversations", before).catch(() => undefined);
    await db.$disconnect();
  }
}, 240_000);

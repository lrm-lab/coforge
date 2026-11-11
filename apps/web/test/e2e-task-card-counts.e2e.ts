import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * A board card's foot says how much talk a Task holds, from the board's own read (task #598): its
 * comments and sent files, and nothing for a Task with none. Seeds a channel, two Tasks and one
 * Task's discussion, and removes them after the run. Screenshots, light, dark and phone, are
 * written under `.amp/e2e/task-card-counts/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/task-card-counts");

test("a card shows its comments and files, and a quiet card shows neither", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `card-counts-${process.pid}`);
  const tail = `${process.pid}-${Date.now().toString(36)}`;
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    orderBy: { createdAt: "asc" },
    include: { workspace: { select: { slug: true } } },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-counts-${tail}`,
      description: "",
      members: { create: { userId: DEV_BROWSER_USER.id } },
    },
    include: { members: true },
  });
  const discussion = await db.conversation.create({ data: { workspaceId, kind: "task_thread" } });
  // Counts belong to task conversations, so the Workspace has them on for this run.
  const experiments = new PrismaExperimentsRepository(db);
  const before = (await experiments.read(workspaceId)).taskConversations;
  await experiments.write(workspaceId, "taskConversations", true);
  const shots = async (name: string) => {
    await browser("screenshot", join(artifacts, `${name}.png`));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await browser("screenshot", join(artifacts, `${name}-dark.png`));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  };
  const marks = (label: string) =>
    `[...document.querySelectorAll('[role="img"]')].filter((mark) => mark.getAttribute("aria-label") === ${JSON.stringify(label)} && mark.getBoundingClientRect().width > 0).length`;
  try {
    const seat = await db.conversationMember.create({
      data: { workspaceId, conversationId: discussion.id, userId: DEV_BROWSER_USER.id },
    });
    const reply = await db.message.create({
      data: {
        conversationId: discussion.id,
        workspaceId,
        senderMemberId: seat.id,
        body: "here are the files",
        sequence: 1,
      },
    });
    await db.attachment.create({
      data: {
        workspaceId,
        conversationId: discussion.id,
        uploaderId: DEV_BROWSER_USER.id,
        messageId: reply.id,
        objectKey: `counts/${crypto.randomUUID()}`,
        fileName: "f.txt",
        contentType: "text/plain",
        sizeBytes: 1,
      },
    });
    const base = {
      workspaceId,
      conversationId: channel.id,
      creatorMemberId: channel.members[0]!.id,
    };
    await db.task.create({
      data: {
        ...base,
        number: 1,
        title: `Talked about ${tail}`,
        discussionConversationId: discussion.id,
      },
    });
    await db.task.create({ data: { ...base, number: 2, title: `Quiet ${tail}` } });
    await mkdir(artifacts, { recursive: true });

    for (const [width, height, label] of [
      ["1440", "900", "desktop"],
      ["390", "844", "phone"],
    ] as const) {
      await browser("set", "viewport", width, height);
      await browser("open", `${origin}/en/w/${workspace.slug}/tasks?layout=board`);
      await browser("wait", "--fn", `${pageHydrated} && ${marks("Comments: 1")} === 1`);
      expect(await evaluate<number>(marks("Files: 1"))).toBe(1);
      await shots(label);
    }
  } finally {
    await browser("close").catch(() => undefined);
    await experiments.write(workspaceId, "taskConversations", before).catch(() => undefined);
    await db.task.deleteMany({ where: { conversationId: channel.id } }).catch(() => undefined);
    await db.conversation
      .deleteMany({ where: { id: { in: [channel.id, discussion.id] } } })
      .catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);

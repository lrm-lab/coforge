import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * Wherever a line names someone, their face is before the name (Frank, 11-04, task #521). Opt-in
 * like the other browser E2Es; the channel, Agent and Task are seeded per run and removed after
 * it. Screenshots go under `.amp/e2e/avatars-everywhere/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/avatars-everywhere");

test("names carry their faces", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `avatars-everywhere-${process.pid}`);
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
    await experiments.write(workspaceId, "taskConversations", true);
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
    const dialog = `[...document.querySelectorAll('[role="dialog"]')].at(-1)`;
    const openHistory = async () => {
      await browser(
        "open",
        `${origin}/en/w/${workspace.slug}/channel/${channel.id}?task=${number}`,
      );
      await browser(
        "wait",
        "--fn",
        `${pageHydrated} && [...(${dialog}?.querySelectorAll('[role="tab"]') ?? [])].some((el) => el.textContent.trim() === "History")`,
      );
      await evaluate(
        `([...${dialog}.querySelectorAll('[role="tab"]')].find((el) => el.textContent.trim() === "History").setAttribute("data-e2e-history", ""), true)`,
      );
      await browser("click", "[data-e2e-history]");
      await browser("wait", "--fn", `${dialog}.textContent.includes("Owner: ")`);
      await browser("wait", "500");
    };

    // Task History: each entry's actor, and the owner a change names, by face.
    await browser("set", "viewport", "1280", "900");
    await openHistory();
    await shoot("history");
    const history = `${dialog}.querySelector("ol")`;
    // The creator (the person) and the new owner (the Agent, its mascot) each have a face.
    expect(
      await evaluate<number>(`${history}.querySelectorAll("img").length`),
    ).toBeGreaterThanOrEqual(3);
    await browser("set", "viewport", "390", "844");
    await openHistory();
    await shoot("history-phone");

    // A system notice: who added whom, each by face, in the one muted line.
    const notices = await db.conversation.create({
      data: {
        workspaceId,
        channelName: `e2e-faces-notice-${tail}`,
        description: "",
        lastSequence: 1,
        members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
      },
    });
    cleanup.push(notices.id);
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
      await shoot(name);
    }
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: { in: cleanup } } }).catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await experiments.write(workspaceId, "taskConversations", before).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);

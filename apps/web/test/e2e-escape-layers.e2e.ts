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
  menuItemNamed,
  pageHydrated,
} from "./helpers/browser-e2e";

/**
 * Escape leaves one layer at a time in a channel: select mode ends on Escape with focus on the
 * page; a Task popup left open over select mode takes the next Escape alone, with focus stranded
 * on the page; with select mode off it closes on Escape.
 * Seeds a channel with messages, a second member and a Task, and removes them after. The last
 * frame is under `.amp/e2e/escape-layers/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/escape-layers");

test("Escape leaves select mode and the Task popup one layer at a time", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor } = browserSession(
    browserPath,
    `escape-layers-${process.pid}`,
  );
  const board = new TaskBoard(db);
  const experiments = new PrismaExperimentsRepository(db);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const as = { workspaceId, userId: DEV_BROWSER_USER.id };
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  const peer = await db.user.create({
    data: { username: `esc-peer-${tail}`, displayName: `Esc Peer ${tail}` },
  });
  await db.workspaceMembership.create({ data: { workspaceId, userId: peer.id, role: "member" } });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-layers-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { userId: peer.id }] },
    },
    include: { members: true },
  });
  const sender = channel.members.find((member) => member.userId === DEV_BROWSER_USER.id)!;
  const before = (await experiments.read(workspaceId)).taskConversations;
  try {
    for (const sequence of [1, 2, 3])
      await db.message.create({
        data: {
          workspaceId,
          conversationId: channel.id,
          senderMemberId: sender.id,
          sequence,
          body: `Layer message ${sequence} ${tail}`,
        },
      });
    await db.conversation.update({ where: { id: channel.id }, data: { lastSequence: 3 } });
    await experiments.write(workspaceId, "taskConversations", true);
    const task = (
      await board.execute(as, {
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        operation: "create",
        title: `Layer task ${tail}`,
      } as Parameters<TaskBoard["execute"]>[1])
    ).tasks[0]!.number;

    const page = `${origin}/en/w/${workspace.slug}/channel/${channel.id}`;
    const popup = `document.querySelector('[role="dialog"]') !== null`;
    const selecting = `document.querySelector("[data-selection-bar]") !== null`;
    const row = `li[data-message-id]`;
    const blurFocus = () => evaluate(`(document.activeElement?.blur?.(), true)`);
    const openChannel = async (search = "") => {
      await browser("open", `${page}${search}`);
      await waitFor(`${pageHydrated} && document.querySelector('${row}') !== null`);
    };
    const enterSelectMode = async () => {
      await evaluate(`(document.querySelector('${row} [aria-label="More"]').click(), true)`);
      await waitFor(`${menuItemNamed("Select messages")} !== undefined`);
      await evaluate(`(${menuItemNamed("Select messages")}.click(), true)`);
      await waitFor(selecting);
    };
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1280", "860");

    const stays = async (condition: string) => {
      await waitFor(`document.getAnimations().every((a) => a.playState !== "running")`);
      await Bun.sleep(400);
      expect(await evaluate<boolean>(condition)).toBe(true);
    };

    await openChannel();
    await enterSelectMode();
    await blurFocus();
    await browser("press", "Escape");
    await waitFor(`!(${selecting})`);

    await openChannel(`?task=${task}`);
    await waitFor(popup);
    await enterSelectMode();
    await stays(`${selecting} && ${popup}`);
    await blurFocus();
    await browser("press", "Escape");
    await waitFor(`!(${popup})`);
    await stays(selecting);
    await browser("press", "Escape");
    await waitFor(`!(${selecting})`);

    await openChannel(`?task=${task}`);
    await waitFor(popup);
    await blurFocus();
    await browser("press", "Escape");
    await waitFor(`!(${popup})`);
    await browser("screenshot", join(artifacts, "popup-closed.png"));
    expect(await evaluate<boolean>(selecting)).toBe(false);
  } finally {
    await browser("close").catch(() => undefined);
    await experiments.write(workspaceId, "taskConversations", before).catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: peer.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 300_000);

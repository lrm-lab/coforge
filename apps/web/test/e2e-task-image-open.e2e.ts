import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { LocalFileStorage } from "#src/server/files/file-storage.server";
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
 * An image opened from a Task popup's discussion on a phone opens its review without the page
 * looking for a message it does not hold ("Messages could not be loaded", Frank, 11-07). Opt-in
 * like the other browser E2Es; needs `COFORGE_FILE_STORAGE_DIR`. Screenshots go under
 * `.amp/e2e/task-image-open/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const storageRoot = Bun.env.COFORGE_FILE_STORAGE_DIR;
if (!storageRoot) throw new Error("COFORGE_FILE_STORAGE_DIR is required");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/task-image-open");
const image = join(import.meta.dir, "../public/apple-touch-icon.png");

test("an image in a Task popup's discussion opens without a load error", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const files = new LocalFileStorage(storageRoot);
  const { browser, evaluate } = browserSession(browserPath, `task-image-${process.pid}`);
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
      name: `e2e-task-image-${tail}`,
      displayName: `Task Agent ${tail}`,
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: { runtime: "pi", provider: { kind: "default" }, model: "", modelProvider: "", reasoning: "" },
    },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-task-image-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
    },
  });
  const fileName = `shot-${tail}.png`;
  const objectKey = `e2e/task-image-open/${tail}/original`;
  try {
    await experiments.write(workspaceId, "taskConversations", true);
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
        dependencies: { publisher: centrifugo, realtime: new CentrifugoConversationRealtime(centrifugo) },
      },
      getMessageRequestIdempotency(),
    );
    await conversations.reply(
      { workspaceId, agentId: agent.id },
      { target: `#${channel.channelName}`, number },
      { idempotencyKey: crypto.randomUUID(), body: `Screenshot attached ${tail}`, mentions: [] },
    );
    const reply = await db.message.findFirstOrThrow({
      where: { sender: { agentId: agent.id }, body: { contains: "Screenshot attached" } },
      select: { id: true, conversationId: true },
    });
    const bytes = await Bun.file(image).arrayBuffer();
    await files.put(objectKey, new Blob([bytes]), "image/png");
    await db.attachment.create({
      data: {
        workspaceId,
        conversationId: reply.conversationId,
        messageId: reply.id,
        uploaderId: DEV_BROWSER_USER.id,
        objectKey,
        fileName,
        contentType: "image/png",
        sizeBytes: bytes.byteLength,
      },
    });

    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}?task=${number}`);
    const thumbnail = `[role="dialog"] button[aria-label="${fileName}"]`;
    await browser("wait", "--fn", `${pageHydrated} && Boolean(document.querySelector('${thumbnail}'))`);
    await browser("click", thumbnail);
    await browser("wait", "--fn", `new URL(location.href).searchParams.has("file")`);
    await browser("wait", "1500");
    await browser("screenshot", join(artifacts, "phone.png"));
    expect(await evaluate<boolean>(`document.body.textContent.includes("could not be loaded")`)).toBe(false);
    expect(await evaluate<string | null>(`new URL(location.href).searchParams.get("message")`)).toBe(null);
  } finally {
    await experiments.write(workspaceId, "taskConversations", before === true).catch(() => {});
    await browser("close").catch(() => undefined);
    await db.attachment.deleteMany({ where: { objectKey } }).catch(() => undefined);
    await db.message.deleteMany({ where: { sender: { agentId: agent.id } } }).catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);

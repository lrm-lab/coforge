import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { LocalFileStorage } from "#src/server/files/file-storage.server";
import { deleteAttachmentRows } from "#src/server/db/repositories/attachment-deletion.repositories.server";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/** Opt-in comment replies and reactions E2E, on the same private stack as e2e-attachment-comments:
 * local built Web with development skip-auth, PostgreSQL, Redis, Centrifugo and ego-browser.
 * DATABASE_URL, COFORGE_E2E_WEB_URL, COFORGE_E2E_CENTRIFUGO_URL and COFORGE_FILE_STORAGE_DIR must
 * name that stack. Creates one channel with a text file and deletes them afterwards.
 * Screenshots: .amp/e2e/attachment-comment-replies/. */
const databaseUrl = Bun.env.DATABASE_URL;
const web = Bun.env.COFORGE_E2E_WEB_URL;
const centrifugo = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
const storageRoot = Bun.env.COFORGE_FILE_STORAGE_DIR;
const browser = Bun.which("ego-browser");
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
if (!web || new URL(web).hostname !== "127.0.0.1")
  throw new Error("COFORGE_E2E_WEB_URL must target local Web");
if (!centrifugo) throw new Error("COFORGE_E2E_CENTRIFUGO_URL is required");
if (!storageRoot) throw new Error("COFORGE_FILE_STORAGE_DIR is required");
if (!browser) throw new Error("ego-browser is required");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const files = new LocalFileStorage(storageRoot);
const proxy = sameOriginProxy(web, centrifugo);

const suffix = String(process.pid);
const fileName = `notes-${suffix}.txt`;
const rootBody = `Is this the final draft ${suffix}`;
const replyBody = `Yes, final ${suffix}`;
const artifacts = join(import.meta.dir, "../../../.amp/e2e/attachment-comment-replies");
const space = "coforge-ui task112 replies";
let objectKey = "";
let conversationId = "";
let pageUrl = "";
let browserPassed = false;

async function runBrowser(script: string) {
  const child = Bun.spawn([browser!, "nodejs"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(script);
  child.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
  return `${stdout}\n${stderr}`;
}

beforeAll(async () => {
  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    include: { workspace: true },
  });
  const workspaceId = membership.workspaceId;
  const conversation = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `replies-${suffix}`,
      members: { create: { userId: DEV_BROWSER_USER.id } },
    },
    include: { members: true },
  });
  conversationId = conversation.id;
  const message = await db.message.create({
    data: {
      workspaceId,
      conversationId,
      senderMemberId: conversation.members[0].id,
      body: "Please review these files",
      sequence: 1,
    },
  });
  const content = "Draft\n";
  objectKey = `e2e/comment-replies/${suffix}/original`;
  await files.put(objectKey, new Blob([content]), "text/plain");
  await db.attachment.create({
    data: {
      workspaceId,
      conversationId,
      messageId: message.id,
      uploaderId: DEV_BROWSER_USER.id,
      objectKey,
      fileName,
      contentType: "text/plain",
      sizeBytes: new TextEncoder().encode(content).length,
    },
  });
  pageUrl = `${proxy.origin}/en/w/${membership.workspace.slug}/channel/${conversationId}`;
  await mkdir(artifacts, { recursive: true });
});

afterAll(async () => {
  proxy.stop();
  if (conversationId) {
    await deleteAttachmentRows(db, { conversationId });
    await db.message.deleteMany({ where: { conversationId } });
    await db.conversation.delete({ where: { id: conversationId } });
  }
  if (objectKey) await files.remove(objectKey);
  await db.$disconnect();
  if (browserPassed && Bun.env.COFORGE_E2E_KEEP_BROWSER !== "1")
    await runBrowser(
      `const task = await taskSpace(${JSON.stringify(space)}); await task.finish({ keep: [] });`,
    );
});

test("a reply and a ✅ on a comment are kept, counted and shown again", async () => {
  const open = `button[aria-label="Preview ${fileName}"]`;
  const result = await runBrowser(`
    const task = await taskSpace(${JSON.stringify(space)});
    const page = task.page("p1");
    await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.goto(${JSON.stringify(pageUrl)});
    await page.waitForSelector(${JSON.stringify(open)}, { timeout: 30000 });
    await page.click(${JSON.stringify(open)});
    await page.waitForSelector('[role="dialog"] textarea');
    await page.fill('[role="dialog"] textarea', ${JSON.stringify(rootBody)});
    await page.click("loc=role:button[name='Post comment']");
    await page.waitForFunction((body) => document.body.innerText.includes(body), ${JSON.stringify(rootBody)}, { timeout: 10000 });

    // ✅ comes from the same quick reactions as a message's.
    await page.click("loc=role:button[name='Add reaction']");
    await page.click("loc=role:button[name='✅']");
    await page.waitForFunction(() => document.querySelector('[role="dialog"] article button[aria-pressed="true"]')?.textContent.trim() === "✅ 1", undefined, { timeout: 10000 });

    await page.click("loc=role:button[name='Reply']");
    await page.waitForSelector('[role="dialog"] textarea[aria-label="Reply"]');
    await page.fill('[role="dialog"] textarea[aria-label="Reply"]', ${JSON.stringify(replyBody)});
    await page.click("loc=role:button[name='Post reply']");
    await page.waitForFunction((body) => document.body.innerText.includes(body), ${JSON.stringify(replyBody)}, { timeout: 10000 });

    await page.reload();
    await page.waitForSelector(${JSON.stringify(open)});
    await page.click(${JSON.stringify(open)});
    await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent.trim() === "1 reply"), undefined, { timeout: 10000 });
    if (await page.evaluate((body) => document.body.innerText.includes(body), ${JSON.stringify(replyBody)})) throw new Error("Replies should stay folded until opened");
    if (!(await page.evaluate(() => document.querySelector('[role="dialog"] article button[aria-pressed="true"]')?.textContent.trim() === "✅ 1"))) throw new Error("✅ was not kept");
    await page.click("loc=role:button[name='1 reply']");
    await page.waitForFunction((body) => document.body.innerText.includes(body), ${JSON.stringify(replyBody)}, { timeout: 10000 });
    console.log(await page.screenshot({ path: ${JSON.stringify(join(artifacts, "replies.png"))} }));
    console.log("E2E_REPLY_AND_RESOLVED_KEPT");
  `);
  expect(result).toContain("E2E_REPLY_AND_RESOLVED_KEPT");
  const root = await db.message.findFirstOrThrow({ where: { body: rootBody } });
  const reply = await db.message.findFirstOrThrow({ where: { body: replyBody } });
  expect(reply.threadRootId).toBe(root.id);
  expect(reply.conversationId).toBe(root.conversationId);
  const reactions = await db.messageReaction.findMany({
    where: { messageId: root.id },
    select: { emoji: true },
  });
  expect(reactions).toEqual([{ emoji: "✅" }]);
  browserPassed = true;
}, 90_000);

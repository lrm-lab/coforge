import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { LocalFileStorage } from "#src/server/files/file-storage.server";
import { deleteAttachmentRows } from "#src/server/db/repositories/attachment-deletion.repositories.server";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/** Opt-in E2E: a file opened before joining its channel takes comments as soon as the viewer
 * joins and opens it again, with no wait for a refresh. Same stack as
 * `e2e-attachment-comments.e2e.ts`: local built Web with development skip-auth, seeded dev user,
 * PostgreSQL, Redis, Centrifugo and ego-browser; DATABASE_URL, COFORGE_E2E_WEB_URL,
 * COFORGE_E2E_CENTRIFUGO_URL and COFORGE_FILE_STORAGE_DIR name that private stack. Creates one
 * file/channel, deletes both afterwards. Screenshots: .amp/e2e/attachment-comment-join/. */
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
const filename = `notes-${suffix}.txt`;
const artifacts = join(import.meta.dir, "../../../.amp/e2e/attachment-comment-join");
const space = "coforge-backend task228 comment after join";
let conversationId = "";
let objectKey = "";
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
      channelName: `join-${suffix}`,
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
      body: "Notes to review",
      sequence: 1,
    },
  });
  objectKey = `e2e/comment-join/${suffix}/original`;
  await files.put(objectKey, new Blob(["Notes under review"]), "text/plain");
  await db.attachment.create({
    data: {
      workspaceId,
      conversationId,
      messageId: message.id,
      uploaderId: DEV_BROWSER_USER.id,
      objectKey,
      fileName: filename,
      contentType: "text/plain",
      sizeBytes: 18,
    },
  });
  // The viewer left after posting: the channel is public to them, and its files read-only.
  await db.conversationMember.update({
    where: { id: conversation.members[0].id },
    data: { leftAt: new Date() },
  });
  pageUrl = `${proxy.origin}/en/w/${membership.workspace.slug}/channel/${conversationId}`;
  await mkdir(artifacts, { recursive: true });
});
afterAll(async () => {
  proxy.stop();
  if (conversationId) {
    await deleteAttachmentRows(db, { conversationId });
    await db.message.deleteMany({ where: { conversationId } });
    await db.conversationMember.deleteMany({ where: { conversationId } });
    await db.conversation.delete({ where: { id: conversationId } });
  }
  if (objectKey) await files.remove(objectKey);
  await db.$disconnect();
  if (browserPassed && Bun.env.COFORGE_E2E_KEEP_BROWSER !== "1")
    await runBrowser(
      `const task = await taskSpace(${JSON.stringify(space)}); await task.finish({ keep: [] });`,
    );
});

test("a file opened before joining takes comments the moment it is opened after joining", async () => {
  const preview = `button[aria-label="Preview ${filename}"]`;
  const result = await runBrowser(`
    const task = await taskSpace(${JSON.stringify(space)});
    const page = task.page("p1");
    await page.goto(${JSON.stringify(pageUrl)});
    await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.waitForSelector(${JSON.stringify(preview)}, { timeout: 30000 });
    await page.click(${JSON.stringify(preview)});
    await page.click('[role="dialog"] button[aria-label="Comments"]');
    await page.waitForFunction(() => document.body.innerText.includes("Join the original conversation to comment.") && document.querySelector('[role="dialog"] textarea')?.disabled, undefined, { timeout: 10000 });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    await page.click("loc=role:button[name='Join Channel']");
    await page.waitForFunction(() => ![...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Join Channel"), undefined, { timeout: 10000 });
    // Well inside the comments' 5-second refresh: the open itself must read the new answer.
    const opened = Date.now();
    await page.click(${JSON.stringify(preview)});
    await page.waitForSelector('[role="dialog"] button[aria-label="Comments"]');
    // The card keeps its comments open from the first look; opened here only if they are not.
    if (await page.evaluate(() => document.querySelector('[role="dialog"] button[aria-label="Comments"]').getAttribute("aria-pressed") !== "true"))
      await page.click('[role="dialog"] button[aria-label="Comments"]');
    await page.waitForFunction(() => {
      const field = document.querySelector('[role="dialog"] textarea');
      return field && field.getClientRects().length > 0 && !field.disabled;
    }, undefined, { timeout: 2500 });
    const sawJoinNote = await page.evaluate(() => document.body.innerText.includes("Join the original conversation to comment."));
    if (sawJoinNote) throw new Error("the stale join note is still shown");
    console.log("E2E_COMMENTABLE_AFTER_MS", Date.now() - opened);
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]')?.closest('[data-entering]'));
    console.log(await page.screenshot({ path: ${JSON.stringify(join(artifacts, "after-join.png"))} }));
    console.log("E2E_COMMENTABLE_AFTER_JOIN");
  `);
  expect(result).toContain("E2E_COMMENTABLE_AFTER_JOIN");
  browserPassed = true;
}, 90_000);

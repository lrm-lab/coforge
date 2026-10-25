import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { LocalFileStorage } from "#src/server/files/file-storage.server";
import { deleteAttachmentRows } from "#src/server/db/repositories/attachment-deletion.repositories.server";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/** Opt-in whole-file comments E2E: local built Web served with development skip-auth,
 * seeded dev user, PostgreSQL, Redis, Centrifugo and ego-browser. DATABASE_URL,
 * COFORGE_E2E_WEB_URL, COFORGE_E2E_CENTRIFUGO_URL and COFORGE_FILE_STORAGE_DIR must
 * name that private stack. Creates one file/channel, deletes both afterwards. Screenshots:
 * .amp/e2e/attachment-comments/. No provider credentials or remote resources required. */
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
const filename = `review-${suffix}.txt`;
const body = `Whole file review ${suffix}`;
const zipName = `archive-${suffix}.zip`;
const zipBody = `Review without preview ${suffix}`;
const zipContent = `Opaque archive bytes ${suffix}`;
const artifacts = join(import.meta.dir, "../../../.amp/e2e/attachment-comments");
let conversationId = "";
let workspaceId = "";
let objectKey = "";
let zipObjectKey = "";
let zipAttachmentId = "";
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
  workspaceId = membership.workspaceId;
  const conversation = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `review-${suffix}`,
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
      body: "Please review this attachment",
      sequence: 1,
    },
  });
  objectKey = `e2e/comments/${suffix}/original`;
  await files.put(objectKey, new Blob(["File under review"]), "text/plain");
  await db.attachment.create({
    data: {
      workspaceId,
      conversationId,
      messageId: message.id,
      uploaderId: DEV_BROWSER_USER.id,
      objectKey,
      fileName: filename,
      contentType: "text/plain",
      sizeBytes: 17,
    },
  });
  zipObjectKey = `e2e/comments/${suffix}-archive/original`;
  await files.put(zipObjectKey, new Blob([zipContent]), "application/zip");
  const zip = await db.attachment.create({
    data: {
      workspaceId,
      conversationId,
      messageId: message.id,
      uploaderId: DEV_BROWSER_USER.id,
      objectKey: zipObjectKey,
      fileName: zipName,
      contentType: "application/zip",
      sizeBytes: new TextEncoder().encode(zipContent).length,
      position: 1,
    },
  });
  zipAttachmentId = zip.id;
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
  if (zipObjectKey) await files.remove(zipObjectKey);
  await db.$disconnect();
  // A failed round keeps its one diagnostic space for recovery; successful standalone runs close it.
  if (browserPassed && Bun.env.COFORGE_E2E_KEEP_BROWSER !== "1")
    await runBrowser(
      'const task = await taskSpace("coforge-backend task116 review revisions"); await task.finish({ keep: [] });',
    );
});

test("commenting on the whole attachment survives refreshing and reopening its preview", async () => {
  const preview = `button[aria-label="Preview ${filename}"]`;
  const result = await runBrowser(`
    const task = await taskSpace("coforge-backend task116 review revisions");
    const page = task.page("p1");
    console.log({ spaceId: task.spaceId });
    await page.goto(${JSON.stringify(pageUrl)});
    await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.waitForSelector(${JSON.stringify(preview)}, { timeout: 30000 });
    console.log(await page.snapshot());
    await page.click(${JSON.stringify(preview)});
    await page.waitForSelector('[role="dialog"] textarea', { timeout: 8000 });
    await page.waitForFunction((name) => document.querySelector('[role="dialog"] textarea')?.placeholder === "Comment on " + name + "…" && document.body.innerText.includes("No comments yet") && document.body.innerText.includes("Comments here relate only to " + name), ${JSON.stringify(filename)});
    await page.hover('[role="dialog"] h2 button');
    await page.waitForSelector('[role="tooltip"]');
    if (!(await page.evaluate(() => document.querySelector('[role="tooltip"]').textContent)).includes(${JSON.stringify(filename)})) throw new Error("Missing filename tooltip");
    await page.click("loc=role:button[name='Collapse comments']");
    await page.waitForFunction(() => document.querySelector('[role="dialog"] textarea')?.getClientRects().length === 0);
    await page.click("loc=role:button[name='Expand comments']");
    await page.waitForFunction(() => document.querySelector('[role="dialog"] textarea')?.getClientRects().length > 0);
    await page.keyboard.press("Escape");
    await page.goto(${JSON.stringify(pageUrl.replace("/en/", "/zh-CN/"))});
    await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.waitForSelector(${JSON.stringify(`button[aria-label="预览 ${filename}"]`)});
    await page.click(${JSON.stringify(`button[aria-label="预览 ${filename}"]`)});
    await page.waitForFunction((name) => document.querySelector('[role="dialog"] textarea')?.placeholder === "评论 " + name + "…" && document.body.innerText.includes("还没有评论") && document.body.innerText.includes("这里的评论仅关联 " + name), ${JSON.stringify(filename)});
    await page.hover('[role="dialog"] h2 button');
    await page.waitForSelector('[role="tooltip"]');
    if (!(await page.evaluate(() => document.querySelector('[role="tooltip"]').textContent)).includes(${JSON.stringify(filename)})) throw new Error("Missing Chinese filename tooltip");
    await page.click("loc=role:button[name='收起评论']");
    await page.waitForFunction(() => document.querySelector('[role="dialog"] textarea')?.getClientRects().length === 0);
    await page.click("loc=role:button[name='展开评论']");
    await page.waitForFunction(() => document.querySelector('[role="dialog"] textarea')?.getClientRects().length > 0);
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]')?.closest('[data-entering]'));
    console.log(await page.screenshot({ path: ${JSON.stringify(join(artifacts, "desktop-zh.png"))} }));
    await page.keyboard.press("Escape");
    await page.goto(${JSON.stringify(pageUrl)});
    await page.waitForSelector(${JSON.stringify(preview)});
    await page.click(${JSON.stringify(preview)});
    await page.waitForSelector('[role="dialog"] textarea');
    await page.fill('[role="dialog"] textarea', ${JSON.stringify(body)});
    await page.click("loc=role:button[name='Post comment']");
    await page.waitForFunction((body) => document.body.innerText.includes(body), ${JSON.stringify(body)}, { timeout: 10000 });
    await page.reload();
    await page.waitForSelector(${JSON.stringify(preview)});
    await page.click(${JSON.stringify(preview)});
    await page.waitForFunction((body) => document.body.innerText.includes(body), ${JSON.stringify(body)}, { timeout: 10000 });
    console.log(await page.snapshot());
    await page.waitForFunction(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return Boolean(dialog && !dialog.closest('[data-entering]'));
    });
    console.log(await page.screenshot({ path: ${JSON.stringify(join(artifacts, "desktop.png"))} }));
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    await page.cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.waitForSelector('button[aria-label="Back to conversations"]');
    await page.click(${JSON.stringify(preview)});
    await page.click("loc=role:button[name='Comments']");
    await page.fill('[role="dialog"] textarea', "Mobile draft survives switching");
    await page.click("loc=role:button[name='Preview']");
    await page.click("loc=role:button[name='Comments']");
    if (await page.evaluate(() => document.querySelector('[role="dialog"] textarea').value) !== "Mobile draft survives switching") throw new Error("Mobile draft was lost");
    await page.evaluate(() => {
      document.documentElement.classList.remove("light-mode");
      document.documentElement.classList.add("dark-mode");
    });
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]')?.getAnimations({ subtree: true }).some((animation) => animation.playState === "running"));
    console.log(await page.screenshot({ path: ${JSON.stringify(join(artifacts, "mobile-dark.png"))} }));
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    await page.click(${JSON.stringify(`button[aria-label="Comments on ${zipName}"]`)});
    await page.waitForSelector('[role="dialog"] textarea', { timeout: 5000 });
    await page.fill('[role="dialog"] textarea', ${JSON.stringify(zipBody)});
    await page.click("loc=role:button[name='Post comment']");
    await page.waitForFunction((body) => document.body.innerText.includes(body), ${JSON.stringify(zipBody)});
    const zipSafety = await page.evaluate(({ id, contents }) => ({
      renderedBytes: document.body.innerText.includes(contents),
      previewRequests: performance.getEntriesByType("resource").filter((entry) => new URL(entry.name).pathname === "/api/attachments/" + id).length,
      download: Boolean(document.querySelector('[role="dialog"] a[href="/api/attachments/' + id + '?download"]')),
    }), { id: ${JSON.stringify(zipAttachmentId)}, contents: ${JSON.stringify(zipContent)} });
    if (zipSafety.renderedBytes || zipSafety.previewRequests !== 0 || !zipSafety.download) throw new Error("ZIP preview/download contract changed: " + JSON.stringify(zipSafety));
    console.log("E2E_ZIP_DISCUSSION_WITHOUT_PREVIEW");
    console.log("E2E_COMMENTS_PERSISTED");
  `);
  expect(result).toContain("E2E_COMMENTS_PERSISTED");
  expect(result).toContain("E2E_ZIP_DISCUSSION_WITHOUT_PREVIEW");
  expect(await db.message.count({ where: { workspaceId, body } })).toBe(1);
  expect(await db.message.count({ where: { workspaceId, body: zipBody } })).toBe(1);
  await db.conversation.update({ where: { id: conversationId }, data: { archivedAt: new Date() } });
  const archived = await runBrowser(`
    const task = await taskSpace("coforge-backend task116 review revisions");
    const page = task.page("p1");
    await page.goto(${JSON.stringify(pageUrl)});
    await page.waitForSelector(${JSON.stringify(preview)});
    await page.click(${JSON.stringify(preview)});
    await page.waitForSelector('[role="dialog"] textarea:disabled', { timeout: 20000 });
    await page.waitForFunction(() => document.body.innerText.includes("This conversation is archived"), undefined, { timeout: 20000 });
    console.log(await page.snapshot());
    console.log("E2E_ARCHIVED_READ_ONLY");
  `);
  expect(archived).toContain("E2E_ARCHIVED_READ_ONLY");
  browserPassed = true;
}, 90_000);

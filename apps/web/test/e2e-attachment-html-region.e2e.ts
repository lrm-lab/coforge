import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { LocalFileStorage } from "#src/server/files/file-storage.server";
import { deleteAttachmentRows } from "#src/server/db/repositories/attachment-deletion.repositories.server";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/** Opt-in HTML region comments E2E, on the same private stack as e2e-attachment-comment-anchors:
 * local built Web with development skip-auth, PostgreSQL, Redis, Centrifugo and ego-browser.
 * DATABASE_URL, COFORGE_E2E_WEB_URL, COFORGE_E2E_CENTRIFUGO_URL and COFORGE_FILE_STORAGE_DIR must
 * name that stack. Creates one channel with one HTML file and deletes them afterwards.
 *
 * The file is hostile on purpose: an inline script, an `onerror` attribute, a `javascript:` link,
 * a meta refresh, a `<noscript>` built to turn into a refresh if it were ever re-serialized, and a
 * nested frame with its own refresh. Each would write `PWNED` into the page or take the frame
 * away from the bridge; the region quotes read back from the database show neither happened.
 * Screenshots: .amp/e2e/attachment-html-region/. */
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
// An absolute `http` link the browser can open without leaving this machine.
const outside = `${web}/api/jwks?from=${suffix}`;
const htmlName = `plans-${suffix}.html`;
// No doctype: a quirks-mode file still lays out in the frame's standards-mode document.
const html = `<html lang="en"><head><title>Plans</title><style>
body { margin: 0; font: 16px/1.5 sans-serif; }
#pricing { box-sizing: border-box; padding: 20px; height: 200px; width: 560px; background: #eef; }
#links { position: absolute; left: 620px; top: 20px; }
#spacer { height: 1800px; }
#footer { box-sizing: border-box; height: 80px; margin: 0; padding: 20px; }
</style></head><body>
<section id="pricing"><h2>Pricing plan</h2><p>Starter costs ten dollars</p></section>
<div id="links"><a href="javascript:document.body.prepend('PWNED-js')">js link</a><br><a href="${outside}">external link</a></div>
<noscript><p title="</noscript><meta http-equiv=refresh content='1;url=https://example.com/'>">noscript fallback</p></noscript>
<script>document.body.prepend("PWNED-script")</script>
<img src="data:," onerror="document.body.prepend('PWNED-onerror')">
<meta http-equiv="refresh" content="1;url=https://example.com/">
<iframe srcdoc="<meta http-equiv=refresh content='0;url=https://example.com/'><p>nested</p>"></iframe>
<div id="spacer"></div>
<p id="footer">Footer note about refunds</p>
</body></html>`;
const regionBody = `Pricing is unclear ${suffix}`;
const pointBody = `Refunds need a date ${suffix}`;
const artifacts = join(import.meta.dir, "../../../.amp/e2e/attachment-html-region");
const space = "coforge-ui task130 html region";
const objectKey = `e2e/html-region/${suffix}/original`;
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
      channelName: `html-region-${suffix}`,
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
      body: "Please review this page",
      sequence: 1,
    },
  });
  await files.put(objectKey, new Blob([html]), "text/html");
  await db.attachment.create({
    data: {
      workspaceId,
      conversationId,
      messageId: message.id,
      uploaderId: DEV_BROWSER_USER.id,
      objectKey,
      fileName: htmlName,
      contentType: "text/html",
      sizeBytes: new Blob([html]).size,
      position: 0,
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
  await files.remove(objectKey);
  await db.$disconnect();
  if (browserPassed && Bun.env.COFORGE_E2E_KEEP_BROWSER !== "1")
    await runBrowser(
      `const task = await taskSpace(${JSON.stringify(space)}); await task.finish({ keep: [] });`,
    );
});

const open = `button[aria-label="Preview ${htmlName}"]`;
const openPreview = `
  await page.waitForSelector(${JSON.stringify(open)}, { timeout: 30000 });
  await page.click(${JSON.stringify(open)});
  await page.waitForSelector('[role="dialog"] iframe');
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]').innerText.includes("Preparing the interactive preview"), undefined, { timeout: 10000 });
  // Measured once the dialog has finished opening: its entry animation scales the frame.
  await page.waitForTimeout(800);
  frame = await page.evaluate(() => {
    const rect = document.querySelector('[role="dialog"] iframe').getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  });
`;
const post = (body: string) => `
  await page.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA", undefined, { timeout: 5000 });
  await page.fill('[role="dialog"] textarea', ${JSON.stringify(body)});
  await page.click("loc=role:button[name='Post comment']");
  await page.waitForFunction((body) => document.body.innerText.includes(body), ${JSON.stringify(body)}, { timeout: 10000 });
`;

test("a dragged region and a clicked point are commented on, kept and jumped to; the file runs nothing", async () => {
  const result = await runBrowser(`
    const task = await taskSpace(${JSON.stringify(space)});
    const page = task.page("p1");
    let frame;
    await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.goto(${JSON.stringify(pageUrl)});
    ${openPreview}
    // Give the refreshes their second, and press both links in preview mode.
    await page.waitForTimeout(1500);
    await page.mouse.click(frame.left + 640, frame.top + 32, { label: "press javascript link" });
    // An http link opens in a new tab, from this page, through the hotspot laid over it.
    const popupPromise = page.waitForEvent("popup");
    await page.mouse.click(frame.left + 640, frame.top + 56, { label: "press external link" });
    const popup = await popupPromise;
    await popup.waitForLoadState();
    console.log("E2E_POPUP " + (await popup.url()));
    await popup.close();
    // A message from this page's own window claiming to be the frame's state is not believed.
    await page.evaluate(() => window.postMessage({ bridge: "coforge-html", type: "state", scrollX: 0, scrollY: 99999, viewportWidth: 1, viewportHeight: 1, documentWidth: 1, documentHeight: 1 }, "*"));

    await page.click("loc=role:button[name='Comment']");
    await page.waitForFunction(() => document.querySelector('[role="dialog"]').innerText.includes("Click or drag to comment on an area"));
    await page.waitForTimeout(300);
    console.log(await page.screenshot({ path: ${JSON.stringify(join(artifacts, "comment-mode.png"))} }));
    await page.mouse.move(frame.left + 5, frame.top + 5);
    await page.mouse.down();
    await page.mouse.move(frame.left + 300, frame.top + 120);
    await page.mouse.move(frame.left + 600, frame.top + 250);
    await page.mouse.up();
    ${post(regionBody)}

    // Still in comment mode: scroll the frame from the layer, then click the last line.
    await page.mouse.move(frame.left + 200, frame.top + 200);
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 1500);
    await page.waitForTimeout(400);
    await page.mouse.click(frame.left + 100, frame.top + frame.height - 40, { label: "comment on footer" });
    ${post(pointBody)}
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector('[role="dialog"]') && !document.querySelector('[role="dialog"]').innerText.includes("Click or drag"));
    console.log("E2E_ESC_KEPT_DIALOG");

    await page.reload();
    ${openPreview}
    await page.click("loc=role:button[name='Go to Footer note about refunds']");
    await page.waitForFunction((frame) => {
      const box = document.querySelector('[role="dialog"] [data-located]')?.getBoundingClientRect();
      return box && box.width >= 14 && box.top >= frame.top && box.bottom <= frame.top + frame.height;
    }, frame, { timeout: 5000 });
    console.log(await page.screenshot({ path: ${JSON.stringify(join(artifacts, "located.png"))} }));
    console.log("E2E_REGION_JUMP");
    await page.evaluate(() => document.documentElement.classList.add("dark-mode"));
    await page.click("loc=role:button[name='Comment']");
    await page.waitForTimeout(300);
    console.log(await page.screenshot({ path: ${JSON.stringify(join(artifacts, "dark-comment-mode.png"))} }));
  `);
  expect(result).toContain(`E2E_POPUP ${outside}`);
  expect(result).toContain("E2E_ESC_KEPT_DIALOG");
  expect(result).toContain("E2E_REGION_JUMP");
  const anchors = await db.attachmentComment.findMany({
    where: { message: { body: { in: [regionBody, pointBody] } } },
    select: { anchorType: true, anchorData: true, message: { select: { body: true } } },
  });
  const byBody = new Map(anchors.map((row) => [row.message.body, row]));
  const region = byBody.get(regionBody)!;
  const point = byBody.get(pointBody)!;
  expect(region.anchorType).toBe("html-region");
  expect(point.anchorType).toBe("html-region");
  const regionData = region.anchorData as Record<string, number | string>;
  const pointData = point.anchorData as Record<string, number | string>;
  // The drag, in document pixels, read against the frame's own state rather than the forged one.
  expect(regionData).toMatchObject({ x: 5, y: 5, w: 595, h: 245 });
  expect(regionData.quote).toContain("Starter costs ten dollars");
  expect(regionData.quote).toContain("noscript fallback");
  // The click: a point, after the layer scrolled the frame to its end.
  expect(pointData).toMatchObject({ w: 0, h: 0, quote: "Footer note about refunds" });
  expect(pointData.y as number).toBeGreaterThan(1500);
  // Nothing in the file ran, and the frame was never taken off the bridge's document.
  for (const data of [regionData, pointData]) expect(String(data.quote)).not.toContain("PWNED");
  browserPassed = true;
}, 120_000);

test("a touch device previews the page but offers no region comments", async () => {
  const result = await runBrowser(`
    const task = await taskSpace(${JSON.stringify(space)});
    const page = await task.newPage();
    let frame;
    await page.cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await page.cdp("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }] });
    await page.goto(${JSON.stringify(pageUrl)});
    ${openPreview}
    const marks = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].filter((button) => button.textContent.trim() === "Comment").length);
    console.log("E2E_TOUCH_MARKS " + marks);
    console.log(await page.screenshot({ path: ${JSON.stringify(join(artifacts, "touch.png"))} }));
    await page.close();
  `);
  expect(result).toContain("E2E_TOUCH_MARKS 0");
}, 60_000);

import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { LocalFileStorage } from "#src/server/files/file-storage.server";
import { deleteAttachmentRows } from "#src/server/db/repositories/attachment-deletion.repositories.server";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/** Opt-in positional comments E2E, on the same private stack as e2e-attachment-comments: local
 * built Web with development skip-auth, PostgreSQL, Redis, Centrifugo and ego-browser.
 * DATABASE_URL, COFORGE_E2E_WEB_URL, COFORGE_E2E_CENTRIFUGO_URL and COFORGE_FILE_STORAGE_DIR must
 * name that stack. Creates one channel with a Markdown, a CSV and two `.ts` files (TypeScript and an
 * MPEG transport stream, both labelled `video/mp2t`) and a log past the text preview's bound, and
 * deletes them afterwards.
 * Screenshots: .amp/e2e/attachment-comment-anchors/. */
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
const markdownName = `guide-${suffix}.md`;
const csvName = `data-${suffix}.csv`;
// Usage sits far below Setup, so the outline has somewhere to scroll to.
const markdown = `# Guide\n\nOverview.\n\n## Setup\n\nInstall the tool.\n\n${"More detail.\n\n".repeat(60)}## Usage\n\nRun it.\n\n${"Even more.\n\n".repeat(60)}`;
const csv = ["id,name", ...Array.from({ length: 60 }, (_, i) => `${i + 1},row ${i + 1}`)].join(
  "\n",
);
const sourceName = `app-${suffix}.ts`;
const source = Array.from({ length: 40 }, (_, i) => `export const value${i + 1} = ${i + 1};`).join(
  "\n",
);
const streamName = `clip-${suffix}.ts`;
// Two 188-byte MPEG-TS packets: the 0x47 sync byte, a header, then binary payload with NULs.
const stream = new Uint8Array(376).map((_, i) => (i % 188 === 0 ? 0x47 : (i * 37) % 256));
const largeName = `big-${suffix}.log`;
const large = "x".repeat(96 * 1024 + 1);
const lineBody = `Line 30 needs a type ${suffix}`;
const sectionBody = `Setup needs a version ${suffix}`;
const rowBody = `Row 45 looks wrong ${suffix}`;
const artifacts = join(import.meta.dir, "../../../.amp/e2e/attachment-comment-anchors");
const space = "coforge-ui task111 anchors";
const objectKeys: string[] = [];
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
      channelName: `anchors-${suffix}`,
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
  for (const [position, [fileName, content, contentType]] of (
    [
      [markdownName, markdown, "text/markdown"],
      [csvName, csv, "text/csv"],
      [sourceName, source, "video/mp2t"],
      [streamName, stream, "video/mp2t"],
      [largeName, large, "text/plain"],
    ] as const
  ).entries()) {
    const objectKey = `e2e/comment-anchors/${suffix}-${position}/original`;
    objectKeys.push(objectKey);
    await files.put(objectKey, new Blob([content]), contentType);
    await db.attachment.create({
      data: {
        workspaceId,
        conversationId,
        messageId: message.id,
        uploaderId: DEV_BROWSER_USER.id,
        objectKey,
        fileName,
        contentType,
        sizeBytes: new Blob([content]).size,
        position,
      },
    });
  }
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
  for (const objectKey of objectKeys) await files.remove(objectKey);
  await db.$disconnect();
  if (browserPassed && Bun.env.COFORGE_E2E_KEEP_BROWSER !== "1")
    await runBrowser(
      `const task = await taskSpace(${JSON.stringify(space)}); await task.finish({ keep: [] });`,
    );
});

/** Browser steps: select `selector`'s text in the open preview, then press the comment button. */
const selectAndComment = (selector: string) => `
  await page.evaluate((selector) => document.querySelector(selector).scrollIntoView({ block: "center" }), ${JSON.stringify(selector)});
  await page.waitForTimeout(400);
  await page.evaluate((selector) => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(selector));
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, ${JSON.stringify(selector)});
  await page.click("loc=role:button[name='Comment']");
`;

test("a comment on a Markdown section and on CSV rows is placed, kept and jumped to", async () => {
  const open = (name: string) => `button[aria-label="Preview ${name}"]`;
  const result = await runBrowser(`
    const task = await taskSpace(${JSON.stringify(space)});
    const page = task.page("p1");
    await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.goto(${JSON.stringify(pageUrl)});
    await page.waitForSelector(${JSON.stringify(open(markdownName))}, { timeout: 30000 });
    await page.click(${JSON.stringify(open(markdownName))});
    await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] h2')].some((h) => h.textContent === "Setup"));
    ${selectAndComment('[role="dialog"] h2 + p')}
    await page.waitForFunction(() => document.querySelector('[role="dialog"] form')?.innerText.includes("§ Setup"));
    await page.fill('[role="dialog"] textarea', ${JSON.stringify(sectionBody)});
    await page.click("loc=role:button[name='Post comment']");
    await page.waitForFunction((body) => document.body.innerText.includes(body), ${JSON.stringify(sectionBody)}, { timeout: 10000 });

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    await page.click(${JSON.stringify(open(csvName))});
    await page.waitForSelector('[role="dialog"] [data-anchor-row="60"]');
    ${selectAndComment('[role="dialog"] [data-anchor-row="45"] [role=cell]:last-child')}
    await page.waitForFunction(() => document.querySelector('[role="dialog"] form')?.innerText.includes("Row 45"));
    await page.fill('[role="dialog"] textarea', ${JSON.stringify(rowBody)});
    await page.click("loc=role:button[name='Post comment']");
    await page.waitForFunction((body) => document.body.innerText.includes(body), ${JSON.stringify(rowBody)}, { timeout: 10000 });

    await page.reload();
    await page.waitForSelector(${JSON.stringify(open(csvName))});
    await page.click(${JSON.stringify(open(csvName))});
    await page.waitForSelector('[role="dialog"] [data-anchor-row="60"]');
    await page.click('[role="dialog"] button[aria-label="Comments"]');
    await page.click("loc=role:button[name='Go to Row 45']");
    await page.waitForFunction(() => {
      const row = document.querySelector('[role="dialog"] [data-anchor-row="45"]');
      const pane = row?.closest(".overflow-auto")?.getBoundingClientRect();
      const box = row?.getBoundingClientRect();
      return row?.classList.contains("bg-tertiary") && box.top >= pane.top && box.bottom <= pane.bottom;
    }, undefined, { timeout: 5000 });
    console.log(await page.screenshot({ path: ${JSON.stringify(join(artifacts, "csv-row.png"))} }));
    console.log("E2E_CSV_ROW_JUMP");

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    await page.click(${JSON.stringify(open(markdownName))});
    await page.click('[role="dialog"] button[aria-label="Comments"]');
    await page.waitForFunction((body) => document.body.innerText.includes(body), ${JSON.stringify(sectionBody)}, { timeout: 10000 });
    await page.click("loc=role:button[name='Go to § Setup']");
    await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] h2')].some((h) => h.textContent === "Setup" && h.classList.contains("ring-2")), undefined, { timeout: 5000 });
    console.log(await page.screenshot({ path: ${JSON.stringify(join(artifacts, "markdown-section.png"))} }));
    console.log("E2E_SECTION_JUMP");

    // The outline lists the sections and scrolls to one.
    const usage = await page.evaluate(() => {
      const rect = [...document.querySelectorAll('[role="dialog"] nav[aria-label="Markdown outline"] button')].find((b) => b.textContent === "Usage").getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.click(usage.x, usage.y, { label: "outline Usage" });
    await page.waitForFunction(() => {
      const heading = [...document.querySelectorAll('[role="dialog"] h2')].find((h) => h.textContent === "Usage");
      const pane = heading?.closest(".overflow-auto")?.getBoundingClientRect();
      const box = heading?.getBoundingClientRect();
      return box && box.top >= pane.top && box.top < pane.top + 120;
    }, undefined, { timeout: 5000 });
    console.log(await page.screenshot({ path: ${JSON.stringify(join(artifacts, "markdown-outline.png"))} }));
    console.log("E2E_OUTLINE_JUMP");
  `);
  expect(result).toContain("E2E_CSV_ROW_JUMP");
  expect(result).toContain("E2E_SECTION_JUMP");
  expect(result).toContain("E2E_OUTLINE_JUMP");
  const anchors = await db.attachmentComment.findMany({
    where: { message: { body: { in: [sectionBody, rowBody] } } },
    select: { anchorType: true, anchorData: true },
    orderBy: { anchorType: "asc" },
  });
  expect(anchors).toEqual([
    { anchorType: "csv-rows", anchorData: { start: 45, end: 45, quote: "row 45" } },
    {
      anchorType: "md-section",
      anchorData: { headingId: "setup", headingTitle: "Setup", quote: "Install the tool." },
    },
  ]);
  browserPassed = true;
}, 90_000);

test("a TypeScript file labelled video/mp2t takes line comments; a real transport stream does not preview", async () => {
  const open = (name: string) => `button[aria-label="Preview ${name}"]`;
  const result = await runBrowser(`
    const task = await taskSpace(${JSON.stringify(space)});
    const page = task.page("p1");
    await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.goto(${JSON.stringify(pageUrl)});
    await page.waitForSelector(${JSON.stringify(open(sourceName))}, { timeout: 30000 });
    await page.click(${JSON.stringify(open(sourceName))});
    await page.waitForSelector('[role="dialog"] [data-anchor-line="40"]');
    ${selectAndComment('[role="dialog"] [data-anchor-line="30"]')}
    await page.waitForFunction(() => document.querySelector('[role="dialog"] form')?.innerText.includes("Line 30"));
    await page.fill('[role="dialog"] textarea', ${JSON.stringify(lineBody)});
    await page.click("loc=role:button[name='Post comment']");
    await page.waitForFunction((body) => document.body.innerText.includes(body), ${JSON.stringify(lineBody)}, { timeout: 10000 });

    await page.reload();
    await page.waitForSelector(${JSON.stringify(open(sourceName))});
    await page.click(${JSON.stringify(open(sourceName))});
    await page.waitForSelector('[role="dialog"] [data-anchor-line="40"]');
    await page.click('[role="dialog"] button[aria-label="Comments"]');
    await page.click("loc=role:button[name='Go to Line 30']");
    await page.waitForFunction(() => document.querySelector('[role="dialog"] [data-anchor-line="30"]')?.classList.contains("bg-tertiary"), undefined, { timeout: 5000 });
    console.log(await page.screenshot({ path: ${JSON.stringify(join(artifacts, "typescript-line.png"))} }));
    console.log("E2E_TS_LINE_JUMP");

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    await page.click(${JSON.stringify(open(streamName))});
    // Read before the dialog opens: not UTF-8, so only its discussion opens, as for any file
    // without a preview.
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.innerText.includes("Comments here relate only to"), undefined, { timeout: 10000 });
    if (await page.evaluate(() => !!document.querySelector('[role="dialog"] [data-anchor-line], [role="dialog"] pre')))
      throw new Error("binary rendered as lines");

    // A log past the 96 KB text bound is not read at all: its card opens the discussion.
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    await page.click(${JSON.stringify(`button[aria-label="Comments on ${largeName}"]`)});
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.innerText.includes("Comments here relate only to"), undefined, { timeout: 10000 });
    await page.waitForTimeout(1000);
    console.log(await page.screenshot({ path: ${JSON.stringify(join(artifacts, "transport-stream.png"))} }));
    console.log("E2E_TS_BINARY_REFUSED");
  `);
  expect(result).toContain("E2E_TS_LINE_JUMP");
  expect(result).toContain("E2E_TS_BINARY_REFUSED");
  const anchor = await db.attachmentComment.findFirstOrThrow({
    where: { message: { body: lineBody } },
    select: { anchorType: true, anchorData: true },
  });
  expect(anchor).toEqual({
    anchorType: "lines",
    anchorData: { start: 30, end: 30, quote: "export const value30 = 30;" },
  });
}, 90_000);

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { deleteAttachmentRows } from "#src/server/db/repositories/attachment-deletion.repositories.server";
import { LocalFileStorage } from "#src/server/files/file-storage.server";
import { browserSession, localBrowserE2e } from "./helpers/browser-e2e";

/**
 * "Generate image" in select mode: picked messages, an image attachment among them, become one
 * share image; a long selection becomes several pages. The preview is the real PNG (its blob is
 * read back). Needs a local built Web with skip-auth and `COFORGE_FILE_STORAGE_DIR`. The suite
 * removes its own Workspace, writer and stored file. Screenshots live in `.amp/e2e/message-share-image/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const storageRoot = Bun.env.COFORGE_FILE_STORAGE_DIR;
if (!storageRoot) throw new Error("COFORGE_FILE_STORAGE_DIR is required");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const files = new LocalFileStorage(storageRoot);
const artifacts = join(import.meta.dir, "../../../.amp/e2e/message-share-image");
const { browser, evaluate } = browserSession(browserPath, `share-image-${process.pid}`);
const prefix = Bun.env.SHOT_PREFIX ?? "share";
const suffix = String(process.pid);
const objectKey = `e2e/share-image/${suffix}/chart.png`;
// A 2×1 PNG, red then blue.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAEElEQVR4nGP4z8AARAwMDAAKBAIBM9eVwwAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);
let workspaceId: string;
let workspaceSlug: string;
let writerId: string;
let channelId: string;
let shortIds: string[];
let longIds: string[];
let hugeId: string;

const waitFor = (expression: string) => browser("wait", "--fn", expression);
const preview = `document.querySelector('[role="dialog"] img[src^="blob:"]')`;
const settle = () =>
  waitFor(
    `!document.querySelector("[data-entering], [data-exiting]") && document.getAnimations().every((animation) => !(animation instanceof CSSTransition) || animation.playState !== "running")`,
  );
const dialogButton = (label: string) =>
  `[...document.querySelectorAll('[role="dialog"] button')].find((b) => (b.getAttribute("aria-label") ?? b.textContent).trim() === ${JSON.stringify(label)})`;

async function shot(name: string) {
  await settle();
  await browser("screenshot", join(artifacts, `${prefix}-${name}.png`));
}

async function select(ids: readonly string[]) {
  await browser("open", `${origin}/en/w/${workspaceSlug}/channel/${channelId}`);
  const row = (id: string) => `document.querySelector('li[data-message-id="${id}"]')`;
  await waitFor(`${row(ids[0]!)} !== null`);
  await browser("eval", `${row(ids[0]!)}.querySelector('[aria-label="More"]').click()`);
  await waitFor(`document.querySelector('[role="menuitem"]') !== null`);
  await browser(
    "eval",
    `[...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.trim() === "Select messages").click()`,
  );
  await waitFor(`document.querySelector("[data-selection-bar]") !== null`);
  // "Select messages" picks the message it was opened on.
  for (const id of ids) {
    await waitFor(`${row(id)}.querySelector("input") !== null`);
    await browser(
      "eval",
      `(() => { const box = ${row(id)}.querySelector("input"); if (!box.checked) box.click(); })()`,
    );
  }
  await waitFor(
    `document.querySelector("[data-selection-bar]").textContent.includes("${ids.length} selected")`,
  );
}

async function generate() {
  await browser("find", "role", "button", "click", "--name", "More actions for selected messages");
  await browser("find", "role", "menuitem", "click", "--name", "Generate image");
  await waitFor(`${preview} !== null && ${preview}.complete`);
}

/** The preview's PNG: its width in pixels, and it is a real PNG of some size. */
async function pageWidth() {
  await browser(
    "eval",
    `window.shareBlob = null; void fetch(${preview}.src).then((r) => r.blob()).then((blob) => { window.shareBlob = blob; })`,
  );
  await waitFor("window.shareBlob !== null");
  const { width, type, size } = await evaluate<{ width: number; type: string; size: number }>(
    `({ width: ${preview}.naturalWidth, type: window.shareBlob.type, size: window.shareBlob.size })`,
  );
  expect(type).toBe("image/png");
  expect(size).toBeGreaterThan(1000);
  return width;
}

beforeAll(async () => {
  await mkdir(artifacts, { recursive: true });
  const writer = await db.user.create({
    data: { username: `share-${suffix}`, displayName: "Ines Okafor" },
  });
  writerId = writer.id;
  const workspace = await db.workspace.create({
    data: {
      name: "Share image",
      slug: `share-image-${suffix}`,
      members: { create: [{ userId: DEV_BROWSER_USER.id, role: "owner" }, { userId: writerId }] },
    },
  });
  workspaceId = workspace.id;
  workspaceSlug = workspace.slug;
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `share-${suffix}`,
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { userId: writerId }] },
    },
    include: { members: true },
  });
  channelId = channel.id;
  const [viewer, other] = channel.members;
  const start = Date.now() - 3_600_000;
  const write = (sequence: number, senderMemberId: string, body: string) =>
    db.message.create({
      data: {
        workspaceId,
        conversationId: channelId,
        senderMemberId,
        sequence,
        body,
        createdAt: new Date(start + sequence * 60_000),
      },
    });
  const short = [
    await write(1, viewer!.id, "现在重启你的 session 以后，你还能创建吗？"),
    await write(
      2,
      other!.id,
      "还能创建。刚才又试了一次，**成功了**：\n\n- 登录列表里已经是未登录\n- 这张 `as_session` 还在\n\nSee [the check](https://example.com/check).",
    ),
    await write(3, viewer!.id, "chart.png"),
    await write(
      4,
      viewer!.id,
      "A chart from the same sender, with task #1 and code:\n\n```\nbun run deploy --stage web\n```",
    ),
  ];
  await files.put(objectKey, new Blob([PNG]), "image/png");
  await db.attachment.create({
    data: {
      workspaceId,
      conversationId: channelId,
      messageId: short[2]!.id,
      uploaderId: DEV_BROWSER_USER.id,
      objectKey,
      fileName: "chart.png",
      contentType: "image/png",
      sizeBytes: PNG.length,
    },
  });
  shortIds = short.map(({ id }) => id);
  longIds = [];
  for (let index = 0; index < 12; index += 1) {
    const message = await write(
      5 + index,
      index % 2 ? viewer!.id : other!.id,
      `Long update ${index + 1}. ${"The rollout moved the web tier first, then the workers, and watched the error rate between each step. ".repeat(4)}`,
    );
    longIds.push(message.id);
  }
  // Taller than Mobile Safari's largest canvas holds at the full scale.
  const huge = await write(
    20,
    viewer!.id,
    Array.from({ length: 800 }, (_, line) => `Line ${line + 1} of the rollout log.`).join("\n"),
  );
  hugeId = huge.id;
});

afterAll(async () => {
  await browser("close").catch(() => undefined);
  await deleteAttachmentRows(db, { conversationId: channelId });
  await db.conversation.deleteMany({ where: { workspaceId } });
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.delete({ where: { id: writerId } });
  await files.remove(objectKey);
  await db.$disconnect();
});

test("picked messages become one share image, at three times the card's width", async () => {
  await browser("set", "viewport", "1440", "900");
  await select(shortIds);
  await generate();
  expect(await pageWidth()).toBe(1440);
  expect(await evaluate<boolean>(`${dialogButton("Download")} !== undefined`)).toBe(true);
  await shot("short-1440");
  // A ratio is drawn again at its own size, however little there is to show.
  await browser("find", "role", "radio", "click", "--name", "16:9");
  await waitFor(
    `${preview} !== null && ${preview}.naturalWidth === 2400 && ${preview}.naturalHeight === 1350`,
  );
  await shot("short-16-9-1440");
  await browser("find", "role", "radio", "click", "--name", "3:4");
  await waitFor(
    `${preview} !== null && ${preview}.naturalWidth === 1440 && ${preview}.naturalHeight === 1920`,
  );
  await shot("short-3-4-1440");
}, 90_000);

test("the image follows the viewer's theme, and a phone previews it whole", async () => {
  const generated = [
    ["390", "844", false, "short-390"],
    ["1440", "900", true, "short-1440-dark"],
    ["390", "844", true, "short-390-dark"],
  ] as const;
  for (const [width, height, dark, name] of generated) {
    await browser("set", "viewport", width, height);
    await select(shortIds);
    if (dark) await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await generate();
    expect(await pageWidth()).toBe(1440);
    await shot(name);
  }
  await browser("set", "viewport", "1440", "900");
}, 90_000);

test("a long selection becomes pages, and the pager moves between them", async () => {
  await select(longIds);
  await generate();
  await waitFor(`${dialogButton("Download all")} !== undefined`);
  // More than a narrow page holds, so the image is the wide one.
  expect(await pageWidth()).toBe(2160);
  const first = await evaluate<string>(`${preview}.src`);
  await evaluate(`${dialogButton("Next page")}.click() ?? true`);
  await waitFor(`${preview}.src !== ${JSON.stringify(first)}`);
  await shot("long-1440");
}, 90_000);

test("a message too tall for a canvas still becomes an image, at a lower scale", async () => {
  await select([hugeId]);
  await generate();
  const { width, height } = await evaluate<{ width: number; height: number }>(
    `({ width: ${preview}.naturalWidth, height: ${preview}.naturalHeight })`,
  );
  expect(width).toBeLessThan(1440);
  expect(width * height).toBeLessThanOrEqual(16_777_216);
  await shot("huge-1440");
}, 90_000);

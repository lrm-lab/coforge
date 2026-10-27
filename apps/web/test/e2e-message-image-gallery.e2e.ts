import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e } from "./helpers/browser-e2e";
import { png } from "./helpers/test-png";

/**
 * A message's images laid out as Raft does (task #212, `attachment-image-box.ts`): a lone image at
 * its own shape within 416×288, a 176×132 box when its size is unknown, and several in a grid at
 * most 360 wide whose wide images take a row of their own. Run with `mise run test:e2e:web
 * e2e-message-image-gallery`. Screenshots and measured boxes live in
 * .amp/e2e/message-image-gallery/. The suite removes its own Workspace and writer.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const artifacts = join(import.meta.dir, "../../../.amp/e2e/message-image-gallery");
const { browser, evaluate } = browserSession(browserPath, `image-gallery-${process.pid}`);
let workspaceId: string;
let workspaceSlug: string;
let writerId: string;
let channelId: string;
let writerMemberId: string;
let sequence = 0;

/** One message from the writer with these images, each `[name, width, height, size known]`. */
async function post(body: string, images: [string, number, number, boolean?][]) {
  const message = await db.message.create({
    data: {
      workspaceId,
      conversationId: channelId,
      senderMemberId: writerMemberId,
      sequence: ++sequence,
      body,
    },
  });
  for (const [position, [name, width, height, known = true]] of images.entries()) {
    const upload = new FormData();
    upload.set("conversationId", channelId);
    upload.set("file", new File([png(width, height)], name, { type: "image/png" }));
    const uploaded = await fetch(`${origin}/api/attachments`, { method: "POST", body: upload });
    expect(uploaded.status).toBe(200);
    const { id } = (await uploaded.json()) as { id: string };
    await db.attachment.update({
      where: { id },
      data: {
        messageId: message.id,
        position,
        imageWidth: known ? width : null,
        imageHeight: known ? height : null,
      },
    });
  }
}

/** Each named image's button box, rounded, once every image has loaded. */
const boxes = (names: string[]) =>
  `(() => Object.fromEntries(${JSON.stringify(names)}.map((name) => { const button = document.querySelector('img[alt="' + name + '"]')?.closest("button"); const r = button?.getBoundingClientRect(); return [name, r && { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }]; })))()`;

beforeAll(async () => {
  await mkdir(artifacts, { recursive: true });
  await db.user.upsert({
    where: { id: DEV_BROWSER_USER.id },
    update: {},
    create: {
      id: DEV_BROWSER_USER.id,
      username: DEV_BROWSER_USER.username,
      displayName: "Image reviewer",
      welcomedAt: new Date(),
    },
  });
  const writer = await db.user.create({
    data: { username: `gallery-writer-${process.pid}`, displayName: "Image writer" },
  });
  writerId = writer.id;
  const workspace = await db.workspace.create({
    data: {
      name: "Image gallery",
      slug: `image-gallery-${process.pid}`,
      members: { create: [{ userId: DEV_BROWSER_USER.id, role: "owner" }, { userId: writerId }] },
    },
  });
  workspaceId = workspace.id;
  workspaceSlug = workspace.slug;
  const channel = await db.conversation.create({ data: { workspaceId, channelName: "gallery" } });
  channelId = channel.id;
  await db.conversationMember.create({
    data: { workspaceId, conversationId: channelId, userId: DEV_BROWSER_USER.id },
  });
  writerMemberId = (
    await db.conversationMember.create({
      data: { workspaceId, conversationId: channelId, userId: writerId },
    })
  ).id;
  await post("A landscape photo.", [["landscape.png", 1200, 900]]);
  await post("A long screenshot.", [["long.png", 300, 2000]]);
  await post("An image of unknown size.", [["unknown.png", 500, 500, false]]);
  await post("Four photos.", [
    ["four-1.png", 400, 300],
    ["four-2.png", 300, 400],
    ["four-3.png", 400, 400],
    ["four-4.png", 400, 300],
  ]);
  await post("Five mixed.", [
    ["mixed-1.png", 400, 300],
    ["mixed-2.png", 400, 300],
    ["mixed-3.png", 1000, 200],
    ["mixed-4.png", 400, 300],
    ["mixed-5.png", 100, 400],
  ]);
});

afterAll(async () => {
  await browser("close");
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (writerId) await db.user.delete({ where: { id: writerId } });
  await db.$disconnect();
});

test("lone images keep their shape; several share a grid with wide ones on a row of their own", async () => {
  const names = [
    "landscape.png",
    "long.png",
    "unknown.png",
    ...[1, 2, 3, 4].map((n) => `four-${n}.png`),
    ...[1, 2, 3, 4, 5].map((n) => `mixed-${n}.png`),
  ];
  await browser("set", "viewport", "1440", "1600");
  await browser("open", `${origin}/en/w/${workspaceSlug}/channel/${channelId}`);
  await browser(
    "wait",
    "--fn",
    `${JSON.stringify(names)}.every((name) => { const i = document.querySelector('img[alt="' + name + '"]'); return i && i.complete && i.naturalWidth > 0; })`,
  );
  const box = await evaluate<
    Record<string, { x: number; y: number; width: number; height: number }>
  >(boxes(names));
  await browser("screenshot", "--full", join(artifacts, "1440.png"));
  await Bun.write(join(artifacts, "1440.json"), JSON.stringify(box, null, 2));

  // A lone image: within 416×288 at its ratio (the border adds a pixel each side).
  expect(box["landscape.png"]).toMatchObject({ width: 384, height: 288 });
  expect(box["long.png"]!.height).toBe(288);
  expect(box["long.png"]!.width).toBeLessThanOrEqual(44);
  expect(box["unknown.png"]).toMatchObject({ width: 176, height: 132 });

  // Four: two rows of two, the group no wider than 360.
  const four = [1, 2, 3, 4].map((n) => box[`four-${n}.png`]!);
  expect(four[0]!.y).toBe(four[1]!.y);
  expect(four[2]!.y).toBe(four[3]!.y);
  expect(four[2]!.y).toBeGreaterThan(four[0]!.y);
  expect(four[1]!.x + four[1]!.width - four[0]!.x).toBeLessThanOrEqual(360);

  // Five with a wide one in the middle: two, the wide one alone, then two.
  const mixed = [1, 2, 3, 4, 5].map((n) => box[`mixed-${n}.png`]!);
  expect(mixed[0]!.y).toBe(mixed[1]!.y);
  expect(mixed[2]!.y).toBeGreaterThan(mixed[0]!.y);
  expect(mixed[2]!.width).toBeGreaterThan(mixed[0]!.width);
  expect(mixed[3]!.y).toBe(mixed[4]!.y);
  expect(mixed[3]!.y).toBeGreaterThan(mixed[2]!.y);
}, 120_000);

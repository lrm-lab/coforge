import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e } from "./helpers/browser-e2e";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/**
 * A conversation image whose size the server knows takes its final box before its bytes arrive
 * (task #191): the image read is held at the proxy, the frame measured, then released and measured
 * again once the image has loaded. Needs a local built Web with skip-auth, PostgreSQL, Redis,
 * local Centrifugo and agent-browser. No model runs. The suite removes its own Workspace and
 * writer. Screenshots and measured boxes live in .amp/e2e/image-reserved-size/.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin || !["localhost", "127.0.0.1"].includes(new URL(centrifugoOrigin).hostname))
  throw new Error("COFORGE_E2E_CENTRIFUGO_URL must target local Centrifugo");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const artifacts = join(import.meta.dir, "../../../.amp/e2e/image-reserved-size");
const { browser, evaluate } = browserSession(browserPath, `image-reserved-size-${process.pid}`);
const [imageWidth, imageHeight] = [600, 400];
let workspaceId: string;
let workspaceSlug: string;
let writerId: string;

/** A solid-colour RGB PNG of the given size. */
function png(width: number, height: number) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([0x7f, 0x56, 0xd9], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

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
    data: { username: `image-writer-${process.pid}`, displayName: "Image writer" },
  });
  writerId = writer.id;
  const workspace = await db.workspace.create({
    data: {
      name: "Image reserved size",
      slug: `image-reserved-size-${process.pid}`,
      members: { create: [{ userId: DEV_BROWSER_USER.id, role: "owner" }, { userId: writerId }] },
    },
  });
  workspaceId = workspace.id;
  workspaceSlug = workspace.slug;
});

afterAll(async () => {
  await browser("close");
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (writerId) await db.user.delete({ where: { id: writerId } });
  await db.$disconnect();
});

for (const width of [1440, 390])
  test(`${width}px: an image of known size holds its final box while it loads`, async () => {
    const name = `${width}`;
    const channel = await db.conversation.create({
      data: { workspaceId, channelName: `image-${name}` },
    });
    await db.conversationMember.create({
      data: { workspaceId, conversationId: channel.id, userId: DEV_BROWSER_USER.id },
    });
    const writer = await db.conversationMember.create({
      data: { workspaceId, conversationId: channel.id, userId: writerId },
    });
    const upload = new FormData();
    upload.set("conversationId", channel.id);
    upload.set(
      "file",
      new File([png(imageWidth, imageHeight)], "reserved.png", { type: "image/png" }),
    );
    const uploaded = await fetch(`${origin}/api/attachments`, { method: "POST", body: upload });
    expect(uploaded.status).toBe(200);
    const { id: attachmentId } = (await uploaded.json()) as { id: string };
    const message = await db.message.create({
      data: {
        workspaceId,
        conversationId: channel.id,
        senderMemberId: writer.id,
        sequence: 1,
        body: "A screenshot.",
      },
    });
    // The size the upload's header read records; set directly so the test does not depend on it.
    await db.attachment.update({
      where: { id: attachmentId },
      data: { messageId: message.id, position: 0, imageWidth, imageHeight },
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const proxy = sameOriginProxy(origin, centrifugoOrigin, {
      async afterUpstream(url) {
        if (url.pathname === `/api/attachments/${attachmentId}`) {
          held = true;
          await gate;
        }
      },
    });
    try {
      const frame = `document.querySelector('img[alt="reserved.png"]')?.parentElement`;
      const box = `(() => { const f=${frame}; if (!f) return null; const r=f.getBoundingClientRect(); const i=f.querySelector("img"); return {width:Math.round(r.width),height:Math.round(r.height),right:Math.round(r.right),row:Math.round(f.closest("li").getBoundingClientRect().right),loaded:!!(i.complete&&i.naturalWidth>0)}; })()`;
      await browser("set", "viewport", String(width), "900");
      await browser("open", `${proxy.origin}/en/w/${workspaceSlug}/channel/${channel.id}`);
      await browser("wait", "--fn", `${frame} != null`);
      await browser(
        "eval",
        "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))",
      );
      const before = await evaluate<{ width: number; height: number; loaded: boolean }>(box);
      await browser("screenshot", join(artifacts, `${name}-loading.png`));
      // The image is served through the proxy unless a signed CDN URL bypasses it.
      expect(held || before.loaded).toBe(true);
      release();
      await browser("wait", "--fn", `(${box})?.loaded === true`);
      await browser(
        "eval",
        "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))",
      );
      const after = await evaluate<{ width: number; height: number; right: number; row: number }>(
        box,
      );
      await browser("screenshot", join(artifacts, `${name}-loaded.png`));
      await Bun.write(
        join(artifacts, `${name}.json`),
        JSON.stringify({ held, before, after }, null, 2),
      );
      expect(held).toBe(true);
      expect(Math.abs(before.width - after.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(before.height - after.height)).toBeLessThanOrEqual(1);
      // A phone's row is narrower than the image: the box shrinks to it, keeping the ratio.
      expect(after.right).toBeLessThanOrEqual(after.row);
      expect(Math.abs(after.width / after.height - imageWidth / imageHeight)).toBeLessThan(0.02);
    } finally {
      release();
      proxy.stop();
    }
  }, 90_000);

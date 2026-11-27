import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e } from "./helpers/browser-e2e";
import { png } from "./helpers/test-png";

const { origin, browserPath, databaseUrl } = localBrowserE2e();
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/message-image-gallery");
const { browser, evaluate } = browserSession(browserPath, `image-gallery-${process.pid}`);
let workspaceId: string;
let workspaceSlug: string;
let writerId: string;
let channelId: string;
let writerMemberId: string;
let sequence = 0;

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
  await browser("close").catch(() => undefined);
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

  expect(box["landscape.png"]).toMatchObject({ width: 360, height: 270 });
  expect(box["long.png"]!.height).toBeGreaterThanOrEqual(286);
  expect(box["long.png"]!.height).toBeLessThanOrEqual(288);
  expect(box["long.png"]!.width).toBeLessThanOrEqual(44);
  expect(box["unknown.png"]).toMatchObject({ width: 176, height: 132 });

  const four = [1, 2, 3, 4].map((n) => box[`four-${n}.png`]!);
  expect(four[0]!.y).toBe(four[1]!.y);
  expect(four[2]!.y).toBe(four[3]!.y);
  expect(four[2]!.y).toBeGreaterThan(four[0]!.y);
  expect(four[1]!.x + four[1]!.width - four[0]!.x).toBeLessThanOrEqual(360);

  const mixed = [1, 2, 3, 4, 5].map((n) => box[`mixed-${n}.png`]!);
  expect(mixed[0]!.y).toBe(mixed[1]!.y);
  expect(mixed[2]!.y).toBeGreaterThan(mixed[0]!.y);
  expect(mixed[2]!.width).toBeGreaterThan(mixed[0]!.width);
  expect(mixed[3]!.y).toBe(mixed[4]!.y);
  expect(mixed[3]!.y).toBeGreaterThan(mixed[2]!.y);
}, 120_000);

const lightbox = () =>
  evaluate<{
    title: string | null;
    position: string | null;
    previous: boolean | null;
    next: boolean | null;
    thumbnails: number;
    current: string | null;
  }>(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const arrow = (label) => { const b = dialog?.querySelector('button[aria-label="' + label + '"]'); return b ? !b.disabled : null; };
    return {
      title: dialog?.getAttribute("aria-label") ?? null,
      position: dialog?.querySelector('[data-lightbox-position] [aria-hidden]')?.textContent ?? null,
      previous: arrow("Previous image"),
      next: arrow("Next image"),
      thumbnails: dialog?.querySelectorAll("[data-lightbox-thumbnails] button").length ?? 0,
      current: dialog?.querySelector('button[aria-current="true"]')?.getAttribute("aria-label") ?? null,
    };
  })()`);

async function at(position: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await lightbox()).position === position) return;
    await Bun.sleep(100);
  }
  expect((await lightbox()).position).toBe(position);
}

async function press(selector: string) {
  await browser("hover", selector);
  await browser("click", selector);
}

const NEXT = '[role="dialog"] button[aria-label="Next image"]';

test("a message's images page in one lightbox: arrows, keys and thumbnails, stopping at the ends", async () => {
  await browser("set", "viewport", "1440", "900");
  await browser("open", `${origin}/en/w/${workspaceSlug}/channel/${channelId}`);
  await browser("wait", 'button:has(img[alt="mixed-1.png"])');
  await browser("click", 'button:has(img[alt="mixed-1.png"])');
  await at("1 / 5");
  expect(await lightbox()).toMatchObject({
    title: "mixed-1.png",
    previous: false,
    next: true,
    thumbnails: 5,
    current: "mixed-1.png",
  });

  await browser("press", "ArrowLeft");
  await browser("press", "ArrowRight");
  await at("2 / 5");
  await browser("press", "ArrowRight");
  await at("3 / 5");
  expect(await lightbox()).toMatchObject({ title: "mixed-3.png", previous: true, next: true });

  await browser("click", '[role="dialog"] button[aria-label="mixed-5.png"]');
  await at("5 / 5");
  expect(await lightbox()).toMatchObject({
    title: "mixed-5.png",
    previous: true,
    next: false,
    current: "mixed-5.png",
  });
  await browser("press", "ArrowRight");
  await browser("press", "ArrowLeft");
  await at("4 / 5");
  await press('[role="dialog"] button[aria-label="Previous image"]');
  await at("3 / 5");

  await press(NEXT);
  await at("4 / 5");
  await press(NEXT);
  await at("5 / 5");
  await browser("press", "Escape");
  await browser("wait", "--fn", `!document.querySelector('[role="dialog"]')`);

  await browser("click", 'button:has(img[alt="landscape.png"])');
  await browser("wait", '[role="dialog"]');
  expect(await lightbox()).toMatchObject({
    title: "landscape.png",
    position: null,
    previous: null,
    next: null,
    thumbnails: 0,
  });
  await browser("press", "Escape");
  await browser("wait", "--fn", `!document.querySelector('[role="dialog"]')`);
}, 120_000);

const STAGE = '[role="dialog"] [data-lightbox-stage]';
const WRAPPER = '[role="dialog"] .react-transform-wrapper';
const CONTENT = '[role="dialog"] .react-transform-component';
const DESKTOP_HEADER = '[role="dialog"] > div:first-child';
const PHONE_ZOOM_BAR = '[role="dialog"] [data-lightbox-zoom-bar]';

async function doubleTapDesktop() {
  await evaluate(`(() => {
    const wrapper = document.querySelector(${JSON.stringify(WRAPPER)});
    const rect = wrapper.getBoundingClientRect();
    wrapper.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    return true;
  })()`);
}

async function doubleTapTouch() {
  const tap = `(() => {
    const wrapper = document.querySelector(${JSON.stringify(WRAPPER)});
    const rect = wrapper.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const t = new Touch({ identifier: 11, target: wrapper, clientX: x, clientY: y, pageX: x, pageY: y });
    wrapper.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [t], targetTouches: [t], changedTouches: [t] }));
    wrapper.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [t] }));
    return true;
  })()`;
  await evaluate(tap);
  await Bun.sleep(40);
  await evaluate(tap);
}

test("image lightbox supports zoom buttons, hotkeys, wheel, double-tap, pan, pinch, and touch controls", async () => {
  await browser("set", "viewport", "1440", "900");
  await browser("open", `${origin}/en/w/${workspaceSlug}/channel/${channelId}`);
  await browser("wait", 'button:has(img[alt="landscape.png"])');
  await browser("click", 'button:has(img[alt="landscape.png"])');
  await browser(
    "wait",
    "--fn",
    `document.querySelector('${DESKTOP_HEADER} button[aria-label="Zoom in"]')?.checkVisibility() && getComputedStyle(document.querySelector('${DESKTOP_HEADER}')).opacity === "1"`,
  );

  expect(
    await evaluate<string>(
      `document.querySelector('${STAGE}')?.getAttribute("data-zoom-scale") ?? ""`,
    ),
  ).toBe("100%");
  expect(
    await evaluate<boolean>(
      `Boolean(document.querySelector('${DESKTOP_HEADER} button[aria-label="Zoom out"]')?.disabled)`,
    ),
  ).toBe(true);
  expect(
    await evaluate<boolean>(
      `Boolean(document.querySelector('${DESKTOP_HEADER} button[aria-label="Reset zoom"]')?.disabled)`,
    ),
  ).toBe(true);

  await press(`${DESKTOP_HEADER} button[aria-label="Zoom in"]`);
  await browser(
    "wait",
    "--fn",
    `document.querySelector('${STAGE}')?.getAttribute("data-zoom-scale") === "125%"`,
  );
  await browser("press", "+");
  await browser(
    "wait",
    "--fn",
    `document.querySelector('${STAGE}')?.getAttribute("data-zoom-scale") === "150%"`,
  );
  const beforePan = await evaluate<string>(
    `document.querySelector('${CONTENT}')?.style.transform ?? ""`,
  );
  await browser("press", "ArrowLeft");
  await browser(
    "wait",
    "--fn",
    `(document.querySelector('${CONTENT}')?.style.transform ?? "") !== ${JSON.stringify(beforePan)}`,
  );
  await browser("press", "0");
  await browser(
    "wait",
    "--fn",
    `document.querySelector('${STAGE}')?.getAttribute("data-zoom-scale") === "100%"`,
  );

  await doubleTapDesktop();
  await browser(
    "wait",
    "--fn",
    `document.querySelector('${STAGE}')?.getAttribute("data-zoom-scale") === "250%"`,
  );
  await Bun.sleep(260);
  const beforeDrag = await evaluate<string>(
    `document.querySelector('${CONTENT}')?.style.transform ?? ""`,
  );
  await evaluate(`(() => {
    const wrapper = document.querySelector(${JSON.stringify(WRAPPER)});
    const rect = wrapper.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    wrapper.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: x, clientY: y }));
    window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: x - 90, clientY: y - 40 }));
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, buttons: 0, clientX: x - 90, clientY: y - 40 }));
    return true;
  })()`);
  expect(
    await evaluate<string>(`document.querySelector('${CONTENT}')?.style.transform ?? ""`),
  ).not.toBe(beforeDrag);
  await doubleTapDesktop();
  await browser(
    "wait",
    "--fn",
    `document.querySelector('${STAGE}')?.getAttribute("data-zoom-scale") === "100%"`,
  );

  await evaluate(`(() => {
    const wrapper = document.querySelector(${JSON.stringify(WRAPPER)});
    const rect = wrapper.getBoundingClientRect();
    wrapper.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120, ctrlKey: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    return true;
  })()`);
  await browser(
    "wait",
    "--fn",
    `Number.parseInt(document.querySelector('${STAGE}')?.getAttribute("data-zoom-scale") ?? "0", 10) > 100`,
  );
  await browser("press", "0");
  await browser(
    "wait",
    "--fn",
    `document.querySelector('${STAGE}')?.getAttribute("data-zoom-scale") === "100%"`,
  );

  await press(`${DESKTOP_HEADER} button[aria-label="Comments"]`);
  await browser("wait", '[role="dialog"] textarea');
  await browser("click", '[role="dialog"] textarea');
  await browser("type", '[role="dialog"] textarea', "+0-");
  await browser("press", "+");
  expect(
    await evaluate<string>(
      `document.querySelector('${STAGE}')?.getAttribute("data-zoom-scale") ?? ""`,
    ),
  ).toBe("100%");
  await press(`${DESKTOP_HEADER} button[aria-label="Comments"]`);
  await browser("press", "Escape");
  await browser("wait", "--fn", `!document.querySelector('[role="dialog"]')`);

  await browser("set", "viewport", "390", "844");
  await browser("wait", "--fn", `window.innerWidth === 390`);
  await browser("click", 'button:has(img[alt="mixed-1.png"])');
  await browser(
    "wait",
    "--fn",
    `document.querySelector('${PHONE_ZOOM_BAR}')?.checkVisibility() && getComputedStyle(document.querySelector('${PHONE_ZOOM_BAR}')).opacity === "1"`,
  );
  const phoneLayout = await evaluate<{
    overflow: boolean;
    belowStage: boolean;
    minTouchWidth: number;
    minTouchHeight: number;
    buttonCount: number;
  }>(`(() => {
    const stage = document.querySelector('${STAGE}').getBoundingClientRect();
    const bar = document.querySelector('${PHONE_ZOOM_BAR}').getBoundingClientRect();
    const buttons = [...document.querySelectorAll('${PHONE_ZOOM_BAR} button')].map((button) => button.getBoundingClientRect());
    return {
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      belowStage: bar.top >= stage.bottom - 1,
      minTouchWidth: Math.min(...buttons.map((box) => box.width)),
      minTouchHeight: Math.min(...buttons.map((box) => box.height)),
      buttonCount: buttons.length,
    };
  })()`);
  expect(phoneLayout.overflow).toBe(false);
  expect(phoneLayout.belowStage).toBe(true);
  expect(phoneLayout.buttonCount).toBe(3);
  expect(phoneLayout.minTouchWidth).toBeGreaterThanOrEqual(44);
  expect(phoneLayout.minTouchHeight).toBeGreaterThanOrEqual(44);

  await browser("click", `${PHONE_ZOOM_BAR} button[aria-label="Zoom in"]`);
  await browser(
    "wait",
    "--fn",
    `document.querySelector('${STAGE}')?.getAttribute("data-zoom-scale") === "125%"`,
  );
  await browser("click", `${PHONE_ZOOM_BAR} button[aria-label="Reset zoom"]`);
  await browser(
    "wait",
    "--fn",
    `document.querySelector('${STAGE}')?.getAttribute("data-zoom-scale") === "100%"`,
  );

  await evaluate(`(() => {
    const wrapper = document.querySelector(${JSON.stringify(WRAPPER)});
    const rect = wrapper.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const t1Start = new Touch({ identifier: 21, target: wrapper, clientX: cx - 30, clientY: cy, pageX: cx - 30, pageY: cy });
    const t2Start = new Touch({ identifier: 22, target: wrapper, clientX: cx + 30, clientY: cy, pageX: cx + 30, pageY: cy });
    wrapper.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [t1Start, t2Start], targetTouches: [t1Start, t2Start], changedTouches: [t1Start, t2Start] }));
    const t1Move = new Touch({ identifier: 21, target: wrapper, clientX: cx - 90, clientY: cy, pageX: cx - 90, pageY: cy });
    const t2Move = new Touch({ identifier: 22, target: wrapper, clientX: cx + 90, clientY: cy, pageX: cx + 90, pageY: cy });
    wrapper.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: [t1Move, t2Move], targetTouches: [t1Move, t2Move], changedTouches: [t1Move, t2Move] }));
    wrapper.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [t1Move, t2Move] }));
    return true;
  })()`);
  await browser(
    "wait",
    "--fn",
    `Number.parseInt(document.querySelector('${STAGE}')?.getAttribute("data-zoom-scale") ?? "0", 10) > 130`,
  );
  await Bun.sleep(260);
  await doubleTapTouch();
  await browser(
    "wait",
    "--fn",
    `document.querySelector('${STAGE}')?.getAttribute("data-zoom-scale") === "100%"`,
  );

  await evaluate(`(() => {
    const stage = document.querySelector(${JSON.stringify(STAGE)});
    const rect = stage.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    stage.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 41, pointerType: "touch", clientX: cx + 90, clientY: cy }));
    stage.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 41, pointerType: "touch", clientX: cx - 20, clientY: cy }));
    stage.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 41, pointerType: "touch", clientX: cx - 120, clientY: cy }));
    stage.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 41, pointerType: "touch", clientX: cx - 120, clientY: cy }));
    return true;
  })()`);
  await at("2 / 5");
  await browser("press", "Escape");
  await browser("wait", "--fn", `!document.querySelector('[role="dialog"]')`);
}, 120_000);

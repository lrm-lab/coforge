import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { devBrowserWorkspace } from "./helpers/browser-e2e";
import { chromePath, launchHeadlessChrome, until } from "./helpers/headless-chrome";

/**
 * Task #27 (Frank): an Agent's description beside its name in the message stream is plain text,
 * cut to the room it has; hovering it opens no tooltip.
 *
 * Opt-in like the other browser E2Es: the real local Web and a headless Chrome over DevTools. The
 * Agent and channel are seeded per run and removed after it. Light, dark and phone frames, with
 * the pointer on the description, are written under `.amp/e2e/agent-description-no-tooltip/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
const databaseUrl = Bun.env.DATABASE_URL;
const chrome = chromePath();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/agent-description-no-tooltip");

/** Under the header's 160-character cap, and too wide for the line, so it is cut. */
const DESCRIPTION =
  "CoForge 后端功能实现（第三位，与另外两位后端分工）：服务端路由与存储、Agent API、daemon 运行时适配。按协调员拆好的子任务认领，先读最新 main 和模块规范，先写测试再实现，每项单独提交。";

test("an Agent's description in the message stream opens no tooltip on hover", async () => {
  if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
    throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
  if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
    throw new Error("DATABASE_URL must target local PostgreSQL");
  if (!chrome) throw new Error("Chrome is required (COFORGE_E2E_CHROME)");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const tail = `${process.pid}-${Date.now()}`.slice(-5);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-description-${tail}`,
      displayName: `Backend Agent ${tail}`,
      description: DESCRIPTION,
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
    },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-description-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
    },
    include: { members: true },
  });
  const agentMember = channel.members.find((member) => member.agentId === agent.id)!;
  const message = await db.message.create({
    data: {
      workspaceId,
      conversationId: channel.id,
      sequence: 1,
      senderMemberId: agentMember.id,
      body: "Routes and storage are in; the daemon adapter is next.",
    },
  });
  await db.conversation.update({ where: { id: channel.id }, data: { lastSequence: 1 } });

  const browser = await launchHeadlessChrome(chrome);
  let page!: Awaited<ReturnType<typeof browser.open>>;
  /** The description: the innermost header element whose whole text it is. */
  const description = `[...document.querySelectorAll('[data-message-id="${message.id}"] *')].find((el) => el.childElementCount === 0 && el.textContent === ${JSON.stringify(DESCRIPTION)})`;
  const shot = async (name: string) => {
    const { data } = await page.command<{ data: string }>("Page.captureScreenshot", {
      format: "png",
    });
    await Bun.write(join(artifacts, `${name}.png`), Buffer.from(data, "base64"));
  };
  /** Rests the pointer on the description long past a tooltip's delay; whether one opened. */
  const hoverOpensTooltip = async () => {
    const { x, y } = await page.evaluate<{ x: number; y: number }>(
      `(() => { const r = ${description}.getBoundingClientRect(); return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 }; })()`,
    );
    await page.command("Input.dispatchMouseEvent", { type: "mouseMoved", x: x - 30, y });
    await page.command("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await Bun.sleep(1500);
    return page.evaluate<boolean>(`document.querySelector('[role="tooltip"]') !== null`);
  };
  const theme = async (dark: boolean) => {
    await page.evaluate(`document.documentElement.classList.toggle("dark-mode", ${dark})`);
    await Bun.sleep(600);
  };
  const viewport = (width: number, height: number, mobile: boolean) =>
    page.command("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 2,
      mobile,
    });

  try {
    await mkdir(artifacts, { recursive: true });
    page = await browser.open(`${origin}/en/w/${workspace.slug}/channel/${channel.id}`);
    await viewport(1280, 800, false);
    await until(() => page.evaluate<boolean>(`${description} != null`), 60_000);

    // Shown as plain text on the author line, cut to the room it has.
    const cut = await page.evaluate<boolean>(
      `(() => { const el = ${description}; return el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === "ellipsis"; })()`,
    );
    expect(cut).toBe(true);

    for (const dark of [false, true]) {
      await theme(dark);
      expect(await hoverOpensTooltip()).toBe(false);
      await shot(`desktop-${dark ? "dark" : "light"}-hover`);
    }
    await theme(false);

    await viewport(390, 844, true);
    await until(() => page.evaluate<boolean>(`${description} != null`));
    expect(await hoverOpensTooltip()).toBe(false);
    await shot("phone-light");
  } finally {
    await browser.close();
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.agentMessageDelivery
      .deleteMany({ where: { agentId: agent.id } })
      .catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);

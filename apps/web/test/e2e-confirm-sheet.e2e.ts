import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/confirm-sheet");

test("a confirmation is a bottom sheet on a phone", async () => {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  const session = `confirm-sheet-${process.pid}`;
  async function browser(...args: string[]) {
    const child = Bun.spawn([browserPath!, "--session", session, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`Browser ${args[0]} failed: ${stderr}`);
    return stdout;
  }
  const waitFor = (condition: string, ms = 20_000) =>
    Promise.race([
      browser("wait", "--fn", condition),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out waiting for ${condition}`)), ms),
      ),
    ]);
  const byText = (selector: string, text: string) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((element) => element.textContent.trim() === ${JSON.stringify(text)}).at(-1)`;

  const channelName = `e2e-confirm-mid-${process.pid}`;
  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    orderBy: { createdAt: "asc" },
    include: { workspace: { select: { slug: true } } },
  });
  const workspacePath = `/en/w/${membership.workspace.slug}`;
  const workspaceId = membership.workspaceId;
  const ownMembership = {
    workspaceId_userId: { workspaceId, userId: DEV_BROWSER_USER.id },
  };
  const channel = await db.conversation.create({
    data: { workspaceId, channelName, description: "" },
  });
  try {
    const member = await db.conversationMember.create({
      data: {
        conversationId: channel.id,
        workspaceId,
        userId: DEV_BROWSER_USER.id,
        channelRole: "admin",
      },
    });
    await db.message.create({
      data: {
        workspaceId,
        conversationId: channel.id,
        senderMemberId: member.id,
        sequence: 1,
        body: "about to be deleted",
      },
    });
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}${workspacePath}/channel/${channel.id}`);
    await waitFor(
      `document.querySelector('[aria-label="Channel details and settings"]') !== null`,
      60_000,
    );
    const panelOpen = `document.querySelector('section[aria-label="Channel details and settings"]') !== null`;
    for (let attempt = 0; ; attempt += 1) {
      await browser("click", '[aria-label="Channel details and settings"]');
      const opened = await waitFor(panelOpen, 5_000).then(
        () => true,
        () => false,
      );
      if (opened) break;
      if (attempt === 5) throw new Error("the channel settings panel never opened");
    }
    await waitFor(`${byText("button", "Delete channel")} !== undefined`);
    const opening = JSON.parse(
      await browser(
        "eval",
        `(async () => {
          const dialogs = () => document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
          const before = dialogs().length;
          ${byText("button", "Delete channel")}.click();
          const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
          const started = performance.now();
          let least = 1;
          let surface = "";
          let frames = 0;
          while (frames < 30 && performance.now() - started < 5000) {
            await frame();
            const dialog = [...dialogs()].at(-1);
            if (dialogs().length <= before || !dialog) continue;
            frames += 1;
            let opacity = 1;
            let painted;
            for (let element = dialog; element; element = element.parentElement) {
              const style = getComputedStyle(element);
              opacity *= Number(style.opacity);
              const background = style.backgroundColor;
              if (!painted && background !== "rgba(0, 0, 0, 0)" && background !== "transparent") painted = background;
            }
            least = Math.min(least, opacity);
            surface = painted ?? "";
          }
          return JSON.stringify({ least, surface, frames });
        })()`,
      ),
    );
    const firstFrames = (typeof opening === "string" ? JSON.parse(opening) : opening) as {
      least: number;
      surface: string;
      frames: number;
    };
    await waitFor(`document.body.textContent.includes("permanently deleted")`);
    await browser("wait", "500");
    const raw = JSON.parse(
      await browser(
        "eval",
        `JSON.stringify((() => { const r = [...document.querySelectorAll('[role="dialog"]')].at(-1).getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight }; })())`,
      ),
    );
    const box = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
      left: number;
      right: number;
      bottom: number;
      width: number;
      height: number;
    };
    await browser("screenshot", join(artifacts, "phone.png"));
    console.log(JSON.stringify(box));
    await browser("eval", `document.documentElement.classList.add("dark-mode")`);
    await browser("wait", "300");
    await browser("screenshot", join(artifacts, "phone-dark.png"));
    await browser("eval", `document.documentElement.classList.remove("dark-mode")`);
    expect(firstFrames.frames).toBe(30);
    expect(firstFrames.least).toBe(1);
    expect(firstFrames.surface).toMatch(/^rgb\(/);
    expect(Math.abs(box.bottom - box.height)).toBeLessThan(2);
    expect(box.left).toBeLessThan(1);
    expect(Math.abs(box.right - box.width)).toBeLessThan(1);
  } finally {
    await db.workspaceMembership
      .update({ where: ownMembership, data: { role: "owner" } })
      .catch(() => {});
    await db.message.deleteMany({ where: { conversationId: channel.id } }).catch(() => {});
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => {});
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 300_000);

import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { animationsSettled } from "./helpers/browser-e2e";

const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/modal-keyboard-viewport");

const KEYBOARD_VIEWPORT = { height: 400, offsetTop: 100 };

test("a dialog's field stays inside the visual viewport the keyboard leaves", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `modal-keyboard-viewport-${process.pid}`;
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
  async function evaluate<T>(expression: string): Promise<T> {
    return JSON.parse(JSON.parse(await browser("eval", `JSON.stringify(${expression})`))) as T;
  }
  const boxes = () =>
    evaluate<{
      overlay: number[];
      dialog: number[];
      field: number[];
      confirm: number[];
      focused: boolean;
    }>(`(() => {
      const dialog = document.querySelector("[data-agent-delete-dialog]");
      const field = dialog.querySelector("input");
      let overlay = dialog;
      while (getComputedStyle(overlay).position !== "fixed") overlay = overlay.parentElement;
      const box = (element) => {
        const { top, bottom } = element.getBoundingClientRect();
        return [Math.round(top), Math.round(bottom)];
      };
      const middle = field.closest("[data-dialog-body]").getBoundingClientRect();
      const fieldBox = field.getBoundingClientRect();
      const shown = [Math.round(Math.max(fieldBox.top, middle.top)), Math.round(Math.min(fieldBox.bottom, middle.bottom))];
      const confirm = dialog.querySelector("[data-agent-delete-confirm]");
      return { overlay: box(overlay), dialog: box(dialog), field: shown, confirm: box(confirm), focused: document.activeElement === field };
    })()`);

  let createdAgent = "";
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id, role: { in: ["owner", "admin"] } },
      orderBy: { createdAt: "asc" },
      include: { workspace: { select: { slug: true, id: true } } },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: membership.workspace.id,
        name: `e2e-keyboard-${process.pid}`,
        displayName: `Keyboard Agent ${process.pid}`,
        ownerId: DEV_BROWSER_USER.id,
        runtimeConfig: {
          runtime: "pi",
          provider: { kind: "default" },
          model: "",
          modelProvider: "",
          reasoning: "",
        },
      },
      select: { id: true },
    });
    createdAgent = agent.id;
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}/en/w/${membership.workspace.slug}/agent/${agent.id}`);
    await browser(
      "wait",
      "--fn",
      `[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Archive Agent")`,
    );
    await browser(
      "eval",
      `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Archive Agent").click()`,
    );
    await browser(
      "wait",
      "--fn",
      `document.activeElement === document.querySelector("[data-agent-delete-dialog] input")`,
    );

    const before = await boxes();
    expect(before.focused).toBe(true);
    expect(before.overlay).toEqual([0, 844]);

    await browser("wait", "--fn", animationsSettled());
    expect(Math.abs((await boxes()).dialog[1] - 844)).toBeLessThan(2);
    await browser("screenshot", join(artifacts, "keyboard-down.png"));
    await browser(
      "eval",
      `(() => {
        const viewport = window.visualViewport;
        Object.defineProperty(viewport, "height", { configurable: true, get: () => ${KEYBOARD_VIEWPORT.height} });
        Object.defineProperty(viewport, "offsetTop", { configurable: true, get: () => ${KEYBOARD_VIEWPORT.offsetTop} });
        viewport.dispatchEvent(new Event("resize"));
        viewport.dispatchEvent(new Event("scroll"));
      })()`,
    );
    const top = KEYBOARD_VIEWPORT.offsetTop;
    const bottom = top + KEYBOARD_VIEWPORT.height;
    await browser(
      "wait",
      "--fn",
      `(() => { let o = document.querySelector("[data-agent-delete-dialog]"); while (getComputedStyle(o).position !== "fixed") o = o.parentElement; const box = o.getBoundingClientRect(); return Math.round(box.top) === ${top} && Math.round(box.bottom) === ${bottom}; })()`,
    );
    await browser(
      "wait",
      "--fn",
      `(() => {
        const dialog = document.querySelector("[data-agent-delete-dialog]");
        const field = dialog.querySelector("input");
        const middle = field.closest("[data-dialog-body]").getBoundingClientRect();
        const reading = [dialog, field].flatMap((element) => {
          const { top, bottom } = element.getBoundingClientRect();
          return [Math.round(top), Math.round(bottom)];
        }).concat([Math.round(middle.top), Math.round(middle.bottom)]);
        const settled = JSON.stringify(reading) === window.__keyboardReading;
        window.__keyboardReading = JSON.stringify(reading);
        return settled && reading[0] >= ${top} && reading[1] <= ${bottom} && reading[3] <= ${bottom};
      })()`,
    );
    const after = await boxes();
    await browser("screenshot", join(artifacts, "keyboard-up.png"));
    expect(after.overlay).toEqual([top, bottom]);
    expect(after.dialog[0]).toBeGreaterThanOrEqual(top);
    expect(after.dialog[1]).toBeLessThanOrEqual(bottom);
    expect(after.field[0]).toBeGreaterThanOrEqual(top);
    expect(after.field[1]).toBeLessThanOrEqual(bottom);
    expect(after.field[1] - after.field[0]).toBeGreaterThanOrEqual(36);
    expect(after.confirm[0]).toBeGreaterThanOrEqual(after.field[1]);
    expect(after.confirm[1]).toBeLessThanOrEqual(bottom);
    expect(after.focused).toBe(true);
    const body = await evaluate<{ scrollTop: number; overflow: number }>(
      `(() => { const body = document.querySelector("[data-agent-delete-dialog] [data-dialog-body]"); return { scrollTop: body.scrollTop, overflow: body.scrollHeight - body.clientHeight }; })()`,
    );
    expect(body).toEqual({ scrollTop: 0, overflow: 0 });
  } finally {
    await browser("close").catch(() => {});
    if (createdAgent) await db.agent.deleteMany({ where: { id: createdAgent } }).catch(() => {});
    await db.$disconnect();
  }
}, 120_000);

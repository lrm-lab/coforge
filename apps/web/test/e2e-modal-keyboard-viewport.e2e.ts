import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * Task #241: on a phone the on-screen keyboard shrinks only the visual viewport, so a dialog's
 * overlay follows the visual viewport (`components/ui/modal.tsx`) and the dialog with its
 * field stays above the keyboard. A browser here has no on-screen keyboard, so the test shrinks
 * `window.visualViewport` the way iOS Safari does (shorter, scrolled down by its offset) and checks
 * that the Agent archive dialog's overlay and its username field sit inside what is left.
 *
 * Opt-in like the other browser E2Es: real local Web (`COFORGE_DEV_SKIP_AUTH=1`) + `agent-browser`
 * against the dev database. It opens the dialog without confirming, so it changes nothing.
 * Screenshots are written under `.amp/e2e/modal-keyboard-viewport/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/modal-keyboard-viewport");

/** The visual viewport with the keyboard up on a 390×844 phone: 400px tall, scrolled 100px down. */
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
  /** The dialog's overlay (its fixed ancestor), the dialog and its field, as top/bottom in px. */
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
      // The part of the field not clipped by the dialog's scrolling middle.
      const middle = field.closest("[data-dialog-body]").getBoundingClientRect();
      const fieldBox = field.getBoundingClientRect();
      const shown = [Math.round(Math.max(fieldBox.top, middle.top)), Math.round(Math.min(fieldBox.bottom, middle.bottom))];
      const confirm = dialog.querySelector("[data-agent-delete-confirm]");
      return { overlay: box(overlay), dialog: box(dialog), field: shown, confirm: box(confirm), focused: document.activeElement === field };
    })()`);

  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id, role: { in: ["owner", "admin"] } },
      include: { workspace: { select: { slug: true, id: true } } },
    });
    // An Agent the viewer may archive: not a system, weekly-report or Workspace assistant.
    const agent = await db.agent.findFirstOrThrow({
      where: {
        workspaceId: membership.workspace.id,
        deletedAt: null,
        systemKind: null,
        weeklyReportAssistant: null,
        workspaceAssistantSession: null,
      },
      select: { id: true },
    });
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

    // Keyboard down: the overlay covers the screen, as before.
    const before = await boxes();
    expect(before.focused).toBe(true);
    expect(before.overlay).toEqual([0, 844]);

    // Keyboard up: React Aria and the overlay both follow `visualViewport`'s resize and scroll.
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
    const after = await boxes();
    await browser("screenshot", join(artifacts, "keyboard-up.png"));
    expect(after.overlay).toEqual([top, bottom]);
    expect(after.dialog[0]).toBeGreaterThanOrEqual(top);
    expect(after.dialog[1]).toBeLessThanOrEqual(bottom);
    expect(after.field[0]).toBeGreaterThanOrEqual(top);
    expect(after.field[1]).toBeLessThanOrEqual(bottom);
    // The whole field shows, and the button that confirms it stays in view below it.
    expect(after.field[1] - after.field[0]).toBeGreaterThanOrEqual(36);
    expect(after.confirm[0]).toBeGreaterThanOrEqual(after.field[1]);
    expect(after.confirm[1]).toBeLessThanOrEqual(bottom);
    expect(after.focused).toBe(true);
  } finally {
    await browser("close").catch(() => {});
    await db.$disconnect();
  }
}, 120_000);

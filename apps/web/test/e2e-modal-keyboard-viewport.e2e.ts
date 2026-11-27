import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import {
  animationsSettled,
  browserSession,
  desktopPointerInitScript,
  devBrowserWorkspace,
  hydratedElement,
  pageDevtools,
  pageHydrated,
} from "./helpers/browser-e2e";

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
      overlayVisibility: string;
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
      return {
        overlay: box(overlay),
        overlayVisibility: getComputedStyle(overlay).visibility,
        dialog: box(dialog),
        field: shown,
        confirm: box(confirm),
        focused: document.activeElement === field,
      };
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
    expect(before.overlayVisibility).toBe("visible");

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

test("feedback dialog stays opaque, unclipped, and touch-friendly at 390px, 320px, and desktop", async () => {
  type Box = {
    left: number;
    right: number;
    top: number;
    bottom: number;
    height: number;
    clipped: boolean;
  };
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const mobile = browserSession(browserPath!, `feedback-mobile-${process.pid}`);
  const desktop = browserSession(browserPath!, `feedback-desktop-${process.pid}`);
  const pointerDir = await mkdtemp(join(tmpdir(), "coforge-feedback-pointer-"));
  let devtools: Awaited<ReturnType<typeof pageDevtools>> | undefined;
  const measurePhone = () =>
    mobile.evaluate<{
      pageFlow: boolean;
      scrollY: number;
      docScrollWidth: number;
      surfaceBg: string;
      header: { cancel: Box; title: Box; send: Box };
      radios: (Box & { direction: string; lines: number })[];
      placeholder: string;
      fontSize: number;
    }>(`(() => {
      const dialog = document.querySelector('[data-phone-page-flow] [role="dialog"]');
      const box = (el, textEl = el) => {
        const r = el.getBoundingClientRect();
        return {
          left: Math.round(r.left),
          right: Math.round(r.right),
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          height: Math.round(r.height),
          clipped: textEl.scrollWidth > textEl.clientWidth + 1,
        };
      };
      let surfaceBg = "";
      for (let el = dialog; el; el = el.parentElement) {
        const bg = getComputedStyle(el).backgroundColor;
        if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
          surfaceBg = bg;
          break;
        }
      }
      const btn = (label) => [...dialog.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
      const cancelBtn = btn("Cancel");
      const sendBtn = btn("Send");
      const titleEl = [...dialog.querySelectorAll("span")].find((s) => s.textContent.trim() === "Send feedback" && s.getBoundingClientRect().width > 0);
      const textarea = dialog.querySelector("textarea");
      return {
        pageFlow: document.querySelector("[data-phone-page-flow]") !== null,
        scrollY: Math.round(window.scrollY),
        docScrollWidth: Math.round(document.documentElement.scrollWidth),
        surfaceBg,
        header: {
          cancel: box(cancelBtn, cancelBtn.querySelector("[data-text]") ?? cancelBtn),
          title: box(titleEl),
          send: box(sendBtn, sendBtn.querySelector("[data-text]") ?? sendBtn),
        },
        radios: [...dialog.querySelectorAll('[role="radiogroup"] label')].map((r) => {
          const span = [...r.querySelectorAll("span")].at(-1) ?? r;
          const range = document.createRange();
          range.selectNodeContents(span);
          return {
            ...box(r, span),
            clipped: r.scrollWidth > r.clientWidth + 1 || span.scrollWidth > span.clientWidth + 1,
            direction: getComputedStyle(r).flexDirection,
            lines: range.getClientRects().length,
          };
        }),
        placeholder: textarea.placeholder,
        fontSize: parseFloat(getComputedStyle(textarea).fontSize),
      };
    })()`);

  const assertPhone = (
    m: Awaited<ReturnType<typeof measurePhone>>,
    width: number,
    height: number,
  ) => {
    expect(m.pageFlow).toBe(true);
    expect(m.scrollY).toBe(0);
    expect(m.docScrollWidth).toBeLessThanOrEqual(width);
    expect(m.surfaceBg).toMatch(/^rgb\(/);
    expect(m.header.cancel.left).toBeGreaterThanOrEqual(0);
    expect(m.header.cancel.right).toBeLessThan(m.header.title.left);
    expect(m.header.title.right).toBeLessThan(m.header.send.left);
    expect(m.header.send.right).toBeLessThanOrEqual(width);
    for (const part of [m.header.cancel, m.header.title, m.header.send]) {
      expect(part.top).toBeGreaterThanOrEqual(0);
      expect(part.bottom).toBeLessThanOrEqual(height);
      expect(part.clipped).toBe(false);
    }
    expect(m.header.cancel.height).toBeGreaterThanOrEqual(44);
    expect(m.radios).toHaveLength(3);
    const firstTop = m.radios[0]!.top;
    for (const radio of m.radios) {
      expect(Math.abs(radio.top - firstTop)).toBeLessThanOrEqual(1);
      expect(radio.height).toBeGreaterThanOrEqual(44);
      expect(radio.left).toBeGreaterThanOrEqual(0);
      expect(radio.right).toBeLessThanOrEqual(width);
      expect(radio.clipped).toBe(false);
    }
    expect(m.placeholder).not.toContain("⌘V");
    expect(m.placeholder).not.toContain("Ctrl+V");
    expect(m.fontSize).toBeGreaterThanOrEqual(16);
  };

  try {
    const { workspace } = await devBrowserWorkspace(db);
    await mobile.browser("set", "viewport", "390", "844");
    await mobile.browser("open", `${origin}/en/w/${workspace.slug}/me`);
    await mobile.waitFor(
      `${pageHydrated} && document.querySelector("[data-tab-home-scroll]") !== null`,
      60_000,
    );
    devtools = await pageDevtools(mobile.browser, "/me");
    await devtools.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await mobile.waitFor(`matchMedia("(pointer: coarse)").matches`);

    const meBtn = `[...document.querySelectorAll("button")].find((b) => b.textContent.includes("Send feedback") && b.getBoundingClientRect().width > 0)`;
    const openPhoneFeedback = async () => {
      await mobile.waitFor(hydratedElement(meBtn));
      await mobile.evaluate(`((${meBtn}).setAttribute("data-e2e-fb-open", ""), true)`);
      await mobile.browser("click", "[data-e2e-fb-open]");
      await mobile.waitFor(
        `document.querySelector('[data-phone-page-flow] [role="dialog"]') !== null`,
      );
      await mobile.waitFor(animationsSettled());
    };

    await openPhoneFeedback();
    const phone390 = await measurePhone();
    assertPhone(phone390, 390, 844);
    expect(phone390.radios.every((r) => r.direction === "row" && r.lines === 1)).toBe(true);

    await mobile.browser(
      "fill",
      '[data-phone-page-flow] [role="dialog"] textarea',
      "Mobile feedback check",
    );
    await mobile.waitFor(
      `[...document.querySelectorAll('[data-phone-page-flow] [role="dialog"] button')].find((b) => b.textContent.trim() === "Send")?.disabled === false`,
    );
    await mobile.evaluate(
      `([...document.querySelectorAll('[data-phone-page-flow] [role="dialog"] button')].find((b) => b.textContent.trim() === "Cancel")?.click(), true)`,
    );
    await mobile.waitFor(`document.querySelectorAll('[role="dialog"]').length === 2`);
    await mobile.waitFor(animationsSettled());

    const nested = await mobile.evaluate<{ overlayVisibility: string; surfaceBg: string }>(`(() => {
      const confirm = document.querySelectorAll('[role="dialog"]')[1];
      let overlay = confirm;
      while (overlay && getComputedStyle(overlay).position !== "fixed") overlay = overlay.parentElement;
      let surfaceBg = "";
      for (let el = confirm; el && el !== overlay; el = el.parentElement) {
        const bg = getComputedStyle(el).backgroundColor;
        if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
          surfaceBg = bg;
          break;
        }
      }
      return { overlayVisibility: overlay ? getComputedStyle(overlay).visibility : "", surfaceBg };
    })()`);
    expect(nested.overlayVisibility).toBe("visible");
    expect(nested.surfaceBg).toMatch(/^rgb\(/);

    await mobile.evaluate(
      `([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === "Discard changes")?.click(), true)`,
    );
    await mobile.waitFor(
      `document.querySelectorAll('[role="dialog"]').length === 0 && document.querySelector('[data-phone-page-flow]') === null`,
    );

    await mobile.browser("set", "viewport", "320", "568");
    await mobile.waitFor(`window.innerWidth === 320`);
    await openPhoneFeedback();
    const phone320 = await measurePhone();
    assertPhone(phone320, 320, 568);
    expect(phone320.radios.every((r) => r.direction === "column" && r.lines === 1)).toBe(true);

    await mobile.browser("set", "viewport", "320", "400");
    await mobile.waitFor(`window.innerHeight === 400`);
    assertPhone(await measurePhone(), 320, 400);

    await mobile.evaluate(
      `([...document.querySelectorAll('[data-phone-page-flow] [role="dialog"] button')].find((b) => b.textContent.trim() === "Cancel")?.click(), true)`,
    );
    await mobile.waitFor(`document.querySelectorAll('[role="dialog"]').length === 0`);

    const pointerInit = await desktopPointerInitScript(pointerDir);
    await desktop.browser("--init-script", pointerInit, "set", "viewport", "1440", "900");
    await desktop.browser("open", `${origin}/en/w/${workspace.slug}/tasks`);
    await desktop.waitFor(
      `${pageHydrated} && document.querySelector('[data-sidebar]') !== null`,
      60_000,
    );
    const desktopBtn = `[...document.querySelectorAll('[data-sidebar] button')].find((b) => b.textContent.includes("Send feedback"))`;
    await desktop.waitFor(hydratedElement(desktopBtn));
    await desktop.evaluate(`((${desktopBtn}).setAttribute("data-e2e-fb-desktop", ""), true)`);
    await desktop.browser("click", "[data-e2e-fb-desktop]");
    await desktop.waitFor(`document.querySelector('[role="dialog"]') !== null`);
    await desktop.waitFor(animationsSettled());

    const desktopState = await desktop.evaluate<{
      pageFlow: boolean;
      placeholder: string;
      actions: { label: string; top: number; bottom: number; left: number; right: number }[];
    }>(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const actions = [...dialog.querySelectorAll("[data-dialog-actions] button")].map((b) => {
        const r = b.getBoundingClientRect();
        return { label: b.textContent.trim(), top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
      });
      return { pageFlow: document.querySelector("[data-phone-page-flow]") !== null, placeholder: dialog.querySelector("textarea").placeholder, actions };
    })()`);
    expect(desktopState.pageFlow).toBe(false);
    expect(desktopState.placeholder).toContain("⌘V / Ctrl+V");
    expect(desktopState.actions.map((a) => a.label)).toEqual(["Cancel", "Send feedback"]);
    for (const action of desktopState.actions) {
      expect(action.top).toBeGreaterThanOrEqual(0);
      expect(action.bottom).toBeLessThanOrEqual(900);
      expect(action.left).toBeGreaterThanOrEqual(0);
      expect(action.right).toBeLessThanOrEqual(1440);
    }

    await desktop.browser("press", "Escape");
    await desktop.waitFor(`document.querySelector('[role="dialog"]') === null`);
  } finally {
    devtools?.close();
    await mobile.browser("close").catch(() => {});
    await desktop.browser("close").catch(() => {});
    await rm(pointerDir, { recursive: true, force: true });
    await db.$disconnect();
  }
}, 120_000);

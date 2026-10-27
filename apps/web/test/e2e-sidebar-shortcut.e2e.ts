import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * Task #232: Cmd+B (Ctrl+B off Apple platforms) collapses and expands the desktop sidebar, also
 * while typing in the message composer, and the toggle's tooltip names the shortcut. In a
 * rich-text editor the key stays bold, so the sidebar does not move.
 *
 * Opt-in like the other browser E2Es: real local Web (`COFORGE_DEV_SKIP_AUTH=1`) + `agent-browser`
 * against the dev database. It creates nothing and clears the preference key it sets.
 * Screenshots are written under `.amp/e2e/sidebar-shortcut/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/sidebar-shortcut");

test("Cmd/Ctrl+B toggles the sidebar, except in a rich-text editor", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `sidebar-shortcut-${process.pid}`;
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
  const collapsed = () =>
    evaluate<boolean>(`document.documentElement.classList.contains("sidebar-collapsed")`);
  const waitCollapsed = (value: boolean) =>
    browser(
      "wait",
      "--fn",
      `document.documentElement.classList.contains("sidebar-collapsed") === ${value}`,
    );
  /** The shortcut as the page's platform spells it, for `press` and the tooltip. */
  const apple = () => evaluate<boolean>(`/Mac|iPhone|iPad|iPod/i.test(navigator.platform)`);
  const COLLAPSE = 'button[aria-label="Collapse sidebar"]';
  const EXPAND = 'button[aria-label="Expand Sidebar"]';
  /** Moves a real pointer onto a button, from off it, so its tooltip opens. */
  async function hover(selector: string) {
    const [x, y] = await evaluate<[number, number]>(
      `(() => { const box = document.querySelector('${selector}').getBoundingClientRect(); return [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)]; })()`,
    );
    await browser("mouse", "move", "700", "450");
    await browser("mouse", "move", String(x), String(y));
  }
  const tooltip = () =>
    evaluate<string | null>(`document.querySelector('[role="tooltip"]')?.textContent ?? null`);

  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${membership.workspace.slug}`);
    await browser("eval", `localStorage.removeItem("coforge-sidebar-expanded")`);
    await browser("reload");
    await browser("wait", "--fn", `document.querySelector('${COLLAPSE}') !== null`);
    expect(await collapsed()).toBe(false);
    const mac = await apple();
    const [press, label] = mac ? ["Meta+b", "⌘B"] : ["Control+b", "Ctrl+B"];

    // The collapse button's tooltip names the shortcut.
    await hover(COLLAPSE);
    await browser("wait", "--fn", `document.querySelector('[role="tooltip"]') !== null`);
    expect(await tooltip()).toBe(`Collapse sidebar${label}`);
    await browser("screenshot", join(artifacts, "collapse-tooltip.png"));

    // From the page, and from the message composer while typing, the key collapses and expands.
    await browser("press", press);
    await waitCollapsed(true);
    expect(await evaluate<string | null>(`localStorage.getItem("coforge-sidebar-expanded")`)).toBe(
      "hide",
    );
    await hover(EXPAND);
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[role="tooltip"]')?.textContent === "Expand Sidebar${label}"`,
    );
    await browser("screenshot", join(artifacts, "expand-tooltip.png"));
    await browser("focus", "textarea");
    await browser("press", press);
    await waitCollapsed(false);

    // In a rich-text editor the key is left to it.
    await browser(
      "eval",
      `(() => { const editor = document.createElement("div"); editor.contentEditable = "true"; editor.id = "e2e-editor"; document.body.append(editor); })()`,
    );
    await browser("focus", "#e2e-editor");
    await browser("press", press);
    await browser("wait", "300");
    expect(await collapsed()).toBe(false);
  } finally {
    await browser("eval", `localStorage.removeItem("coforge-sidebar-expanded")`).catch(
      () => undefined,
    );
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);

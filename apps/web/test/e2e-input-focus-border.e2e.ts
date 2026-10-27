import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * Browser E2E (task #227): a focused text field draws its border in the design spec's brand violet
 * (#5d36dc, `--color-border-input-focus`), and in the lighter brand step (#a993ff) in dark mode,
 * where #5d36dc is too dim on the dark field. Checked on a shared Input (the Records search) and on
 * the chat composer, which draws its own frame.
 *
 * Opt-in like the other browser E2Es: real local Web (`COFORGE_DEV_SKIP_AUTH=1`) + `agent-browser`
 * against the dev database. Screenshots are written under `.amp/e2e/input-focus-border/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/input-focus-border");

const LIGHT = "rgb(93, 54, 220)";
const DARK = "rgb(169, 147, 255)";

test("a focused text field's border is the brand violet, lighter in dark mode", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `input-focus-${process.pid}`;
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
  const waitFor = (condition: string) => browser("wait", "--fn", condition);
  /** The colour the focused field's border is drawn in: the shared Input's ring (an inset box
   * shadow), or the composer's border. */
  const inputRing = `getComputedStyle(document.querySelector('input[type="search"]').closest(".group\\\\/input")).boxShadow`;
  const composerBorder = `getComputedStyle(document.querySelector("main form textarea").closest("form")).borderColor`;
  const setTheme = async (theme: "light" | "dark") => {
    await browser("eval", `localStorage.setItem("coforge-theme", "${theme}")`);
    await browser("reload");
  };

  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    const workspacePath = `/en/w/${membership.workspace.slug}`;
    const channel = await db.conversation.findFirstOrThrow({
      where: { workspaceId: membership.workspaceId, channelName: "general" },
      select: { id: true },
    });
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");

    for (const [theme, color] of [
      ["light", LIGHT],
      ["dark", DARK],
    ] as const) {
      await browser("open", `${origin}${workspacePath}/records`);
      await setTheme(theme);
      await waitFor(`document.querySelector('input[type="search"]') !== null`);
      await browser("focus", 'input[type="search"]');
      await waitFor(`${inputRing}.includes(${JSON.stringify(color)})`);
      expect(await evaluate<string>(inputRing)).toContain(color);
      await browser("screenshot", join(artifacts, `input-${theme}.png`));

      await browser("open", `${origin}${workspacePath}/channel/${channel.id}`);
      await waitFor(`document.querySelector("main form textarea:not([disabled])") !== null`);
      await browser("focus", "main form textarea");
      await waitFor(`${composerBorder} === ${JSON.stringify(color)}`);
      expect(await evaluate<string>(composerBorder)).toBe(color);
      await browser("screenshot", join(artifacts, `composer-${theme}.png`));
    }
  } finally {
    await browser("eval", `localStorage.removeItem("coforge-theme")`).catch(() => undefined);
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);

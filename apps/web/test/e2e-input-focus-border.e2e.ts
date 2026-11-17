import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { pageHydrated } from "./helpers/browser-e2e";

const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/input-focus-border");

const tokenColor = (token: string) => `(() => {
  const probe = document.createElement("i");
  probe.style.color = "var(${token})";
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
})()`;

test("a focused text field's border is the theme's input-focus colour", async () => {
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
  const inputRing = `getComputedStyle(document.querySelector('input[type="search"]').closest(".group\\\\/input")).boxShadow`;
  const textAreaRing = `getComputedStyle(document.querySelector('[role="dialog"] textarea')).boxShadow`;
  const composerFrame = `getComputedStyle(document.querySelector("main form textarea").closest("form"))`;
  const setTheme = async (theme: "light" | "dark") => {
    await browser("eval", `localStorage.setItem("coforge-theme", "${theme}")`);
    await browser("reload");
  };

  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      orderBy: { createdAt: "asc" },
      include: { workspace: { select: { slug: true } } },
    });
    const workspacePath = `/en/w/${membership.workspace.slug}`;
    const channel = await db.conversation.findFirstOrThrow({
      where: { workspaceId: membership.workspaceId, channelName: "general" },
      select: { id: true },
    });
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");

    for (const theme of ["light", "dark"] as const) {
      await browser("open", `${origin}${workspacePath}/records`);
      await setTheme(theme);
      await waitFor(`${pageHydrated} && document.querySelector('input[type="search"]') !== null`);
      const color = await evaluate<string>(tokenColor("--color-field-border-typing"));
      await browser("focus", 'input[type="search"]');
      const ring = `${color} 0px 0px 0px 2px inset`;
      await waitFor(`${inputRing}.includes(${JSON.stringify(ring)})`);
      expect(await evaluate<string>(inputRing)).toContain(ring);
      await browser("screenshot", join(artifacts, `input-${theme}.png`));

      await browser("open", `${origin}${workspacePath}/channel/${channel.id}`);
      await waitFor(
        `${pageHydrated} && document.querySelector("main form textarea:not([disabled])") !== null`,
      );
      const typing = await evaluate<string>(tokenColor("--color-field-border-typing"));
      await browser("focus", "main form textarea");
      const inset = `${typing} 0px 0px 0px 1px inset`;
      await waitFor(
        `${composerFrame}.borderColor === ${JSON.stringify(typing)} && ${composerFrame}.boxShadow.includes(${JSON.stringify(inset)})`,
      );
      expect(await evaluate<string>(`${composerFrame}.borderColor`)).toBe(typing);
      expect(await evaluate<string>(`${composerFrame}.boxShadow`)).toContain(inset);
      await browser("screenshot", join(artifacts, `composer-${theme}.png`));

      await browser("click", 'button[aria-label="Channel details and settings"]');
      await waitFor(`document.querySelector('[role="dialog"] textarea:not([disabled])') !== null`);
      await browser("focus", '[role="dialog"] textarea');
      const textAreaInset = `${typing} 0px 0px 0px 2px inset`;
      await waitFor(`${textAreaRing}.includes(${JSON.stringify(textAreaInset)})`);
      expect(await evaluate<string>(textAreaRing)).toContain(textAreaInset);
      await browser("screenshot", join(artifacts, `textarea-${theme}.png`));
    }
  } finally {
    await browser("eval", `localStorage.removeItem("coforge-theme")`).catch(() => undefined);
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);

import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * The channel header gives its room to the name: at every width a channel name of ordinary length
 * shows whole, and the description stays in the channel's settings. A name too long for the row is
 * cut on its own line and never pushes the actions out.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`, the dev user an owner of
 * its Workspace (seed-dev). Screenshots are written under `.amp/e2e/channel-header-name/`.
 */
const webOrigin = Bun.env.COFORGE_E2E_WEB_URL;
if (!webOrigin || !["localhost", "127.0.0.1"].includes(new URL(webOrigin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/channel-header-name");

test("the channel name keeps its room and the description stays out of the header", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `channel-header-name-${process.pid}`;
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
  const header = `document.querySelector('[aria-label="Channel details and settings"]')?.closest("header")`;
  const measure = `(() => {
    const name = ${header}.querySelector("h1");
    const actions = document.querySelector('[aria-label="Channel details and settings"]');
    return {
      nameWhole: name.scrollWidth <= name.clientWidth,
      descriptionShown: ${header}.textContent.includes("Questions and results"),
      actionsInView: actions.getBoundingClientRect().right <= innerWidth,
    };
  })()`;
  async function shootBoth(name: string) {
    for (const theme of ["", "-dark"]) {
      if (theme) await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
      await browser("wait", "300");
      await browser("screenshot", join(artifacts, `${name}${theme}.png`));
    }
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  }

  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    include: { workspace: { select: { slug: true } } },
  });
  const workspacePath = `/en/w/${membership.workspace.slug}`;
  const workspaceId = membership.workspaceId;
  const description = "Questions and results for every interface change, ".repeat(6).trim();
  const channels = await Promise.all(
    [`e2e-name-${process.pid}`, `e2e-name-${"very-long-".repeat(12)}${process.pid}`].map(
      (channelName) => db.conversation.create({ data: { workspaceId, channelName, description } }),
    ),
  );
  const [ordinary, overlong] = channels;
  try {
    await db.conversationMember.createMany({
      data: channels.map((channel) => ({
        conversationId: channel.id,
        workspaceId,
        userId: DEV_BROWSER_USER.id,
        channelRole: "admin" as const,
      })),
    });
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${webOrigin}${workspacePath}/channel/${ordinary.id}`);
    await browser("wait", "--fn", `Boolean(${header})`);

    for (const width of [1440, 1100, 900, 768]) {
      await browser("set", "viewport", String(width), "800");
      await browser("wait", "300");
      const seen = await evaluate<Record<string, boolean | null>>(measure);
      await shootBoth(`channel-${width}`);
      expect({ width, ...seen } as Record<string, unknown>).toEqual({
        width,
        nameWhole: true,
        descriptionShown: false,
        actionsInView: true,
      });
    }

    await browser("set", "viewport", "390", "844");
    await browser("wait", "300");
    const phone = await evaluate<Record<string, boolean | null>>(measure);
    await shootBoth("channel-390");
    expect(phone.nameWhole).toBe(true);
    expect(phone.descriptionShown).toBe(false);
    expect(phone.actionsInView).toBe(true);

    await browser("open", `${webOrigin}${workspacePath}/channel/${overlong.id}`);
    await browser("wait", "--fn", `Boolean(${header})`);
    const cut = await evaluate<Record<string, boolean | null>>(measure);
    expect(cut.nameWhole).toBe(false);
    expect(cut.actionsInView).toBe(true);
    await browser("set", "viewport", "1440", "900");
    await browser("wait", "300");
    expect((await evaluate<Record<string, boolean | null>>(measure)).actionsInView).toBe(true);
    await shootBoth("overlong-1440");
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: { in: channels.map(({ id }) => id) } } });
    await db.$disconnect();
  }
}, 180_000);

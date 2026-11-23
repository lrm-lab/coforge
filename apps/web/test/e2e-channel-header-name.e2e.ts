import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e } from "./helpers/browser-e2e";

/**
 * The channel header gives its room to the name: at every width a channel name of ordinary length
 * shows whole, and the description stays in the channel's settings. A name too long for the row is
 * cut on its own line and never pushes the actions out.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`, the dev user an owner of
 * its Workspace (seed-dev). Screenshots are written under `.artifacts/e2e/channel-header-name/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/channel-header-name");

test("the channel name keeps its room and the description stays out of the header", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `channel-header-name-${process.pid}`);
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
    orderBy: { createdAt: "asc" },
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
    await browser("open", `${origin}${workspacePath}/channel/${ordinary.id}`);
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

    await browser("open", `${origin}${workspacePath}/channel/${overlong.id}`);
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

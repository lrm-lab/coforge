import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * A message's action bar stays up while a menu it opened is open: the bar's own rule keys on the
 * open trigger, for More as for the reaction picker. A headless browser has no hover, so the test
 * reads what the rule keys on. Seeds a channel with one message and removes it after the run.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();

test("the action bar knows a menu it opened is open", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `toolbar-menu-${process.pid}`);
  const tail = `${process.pid}-${Date.now().toString(36)}`;
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    include: { workspace: { select: { slug: true } } },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-toolbar-${tail}`,
      description: "",
      members: { create: { userId: DEV_BROWSER_USER.id } },
    },
    include: { members: true },
  });
  try {
    await db.message.create({
      data: {
        conversationId: channel.id,
        workspaceId,
        senderMemberId: channel.members[0]!.id,
        body: `Hello ${tail}`,
        sequence: 1,
      },
    });
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}`);
    const more = `document.querySelector('button[aria-label="More"]')`;
    await browser("wait", "--fn", `${pageHydrated} && ${more} !== null`);
    const state = () =>
      evaluate<{ expanded: string | null; haspopup: string | null; barKnows: boolean }>(`(() => {
        const button = ${more};
        return {
          expanded: button.getAttribute("aria-expanded"),
          haspopup: button.getAttribute("aria-haspopup"),
          barKnows: button.parentElement.closest(".group\\\\/message")?.querySelector('[aria-expanded="true"]') != null,
        };
      })()`);
    await evaluate(`(() => { ${more}.click(); return true; })()`);
    await browser("wait", "--fn", `document.querySelector('[role="menu"]') !== null`);
    const open = await state();
    expect(open.expanded).toBe("true");
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);

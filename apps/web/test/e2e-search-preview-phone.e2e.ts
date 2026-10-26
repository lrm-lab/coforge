import { test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, hydrated, seededUuid } from "./helpers/browser-e2e";

/**
 * Search on a phone, in a real browser: there is no room beside the results, so a click opens the
 * result's conversation directly.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channel and its
 * messages are seeded deterministically and reset on every run.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");

test("on a phone a result opens its conversation", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser } = browserSession(browserPath, `search-preview-phone-${process.pid}`);
  const channelId = seededUuid("e2e-search-preview:phone-channel");
  const phrase = "手机预览样本";
  const row = (id: string) => `[data-search-message-id="${id}"]`;
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    const workspacePath = `/en/w/${membership.workspace.slug}`;
    const workspaceId = membership.workspaceId;
    await db.conversation.deleteMany({ where: { id: channelId } });
    await db.conversation.create({
      data: { id: channelId, workspaceId, channelName: "e2e-preview-phone", description: "" },
    });
    const member = await db.conversationMember.create({
      data: { conversationId: channelId, workspaceId, userId: DEV_BROWSER_USER.id },
    });
    const match = await db.message.create({
      data: {
        conversationId: channelId,
        workspaceId,
        senderMemberId: member.id,
        body: `${phrase} on a phone`,
        sequence: 1,
      },
    });

    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}${workspacePath}/search?q=${encodeURIComponent(phrase)}`);
    await browser(
      "wait",
      "--fn",
      `document.querySelector('${row(match.id)}') !== null && ${hydrated}`,
    );
    await browser("click", row(match.id));
    await browser("wait", "--fn", `location.pathname === "${workspacePath}/channel/${channelId}"`);
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channelId } }).catch(() => {});
    await db.$disconnect();
  }
}, 90_000);

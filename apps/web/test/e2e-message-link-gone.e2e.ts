import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * A link into a conversation names a message that is gone (`?message=`: deleted, or never in it).
 * The server answers NOT_FOUND (`ConversationHistory.loadAround`), which no retry can change, so the
 * conversation opens at its latest and says the message no longer exists, never the red "Messages
 * could not be loaded. Try again.", which outlived the page onto Records (Frank, 2026-11-09).
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const dir = join(import.meta.dir, "../../../.amp/e2e/message-link-gone");
const MISSING = "00000000-0000-4000-8000-000000000001";
const toasts = `[...document.querySelectorAll("[data-sonner-toast]")].map((t) => t.textContent)`;

test("a link to a message that is gone opens the conversation and says so, with no load error", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    include: { workspace: { select: { slug: true } } },
  });
  const general = await db.conversation.findFirstOrThrow({
    where: { workspaceId, channelName: "general" },
  });
  const { browser, evaluate } = browserSession(browserPath, `hist-${process.pid}`);
  try {
    await mkdir(dir, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await browser(
      "open",
      `${origin}/en/w/${workspace.slug}/channel/${general.id}?message=${MISSING}`,
    );
    await browser("wait", "--fn", pageHydrated);
    await browser(
      "wait",
      "--fn",
      `${toasts}.some((t) => t.includes("That message no longer exists"))`,
    );
    await browser("wait", "600"); // the notice settles in before the picture
    await browser("screenshot", join(dir, "conversation.png"));
    await browser("eval", `document.querySelector('a[href*="/records"]').click()`);
    await browser("wait", "--fn", `location.pathname.includes("/records")`);
    const shown = await evaluate<string[]>(toasts);
    expect(shown.some((t) => t.includes("Messages could not be loaded"))).toBe(false);
    // The notice belongs to the conversation: leaving it takes the notice away too, well before
    // its own 4 s would have.
    await browser(
      "wait",
      "--fn",
      `!${toasts}.some((t) => t.includes("no longer exists"))`,
      "--timeout",
      "1500",
    );
    // The link is consumed: the conversation's URL no longer names the message.
    await browser("back");
    await browser("wait", "--fn", `location.pathname.includes("/channel/")`);
    expect(await evaluate<string>("location.search")).not.toContain("message=");
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);

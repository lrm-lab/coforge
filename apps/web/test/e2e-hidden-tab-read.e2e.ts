import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";
import { waitFor } from "./helpers/activity-inbox-e2e";
import { seedChannel } from "./helpers/open-unread-e2e";

/**
 * A channel that opens in a background tab reads nothing (task #549): a tab opened behind the
 * current one, or restored when the browser starts, loads the channel's newest messages without
 * anyone looking, so they stay unread (and their sender does not see them as seen) until the page
 * is on screen, which reads them then. A message that arrives while a tab is hidden is not loaded
 * until the tab is back (`conversation-realtime-client.ts`), so loading is where a hidden read
 * could start.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channel, its peer and
 * its messages are seeded deterministically and reset on every run. Screenshots are written under
 * `.amp/e2e/hidden-tab-read/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/hidden-tab-read");

/** The page says it is `state`, as a browser does when its tab is behind another or comes back. */
const visibility = (state: "hidden" | "visible") => `
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => ${JSON.stringify(state)} });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => ${state === "hidden"} });
`;

test("a channel opened in a background tab is read only once the tab is on screen", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `hidden-tab-read-${process.pid}`);
  // The page is hidden from its first script on, before the app reads anything.
  const hiddenFromStart = join(artifacts, "hidden-from-start.js");
  try {
    const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    // Read through the first message; the second arrived since.
    const channel = await seedChannel(db, workspaceId, "e2e-hidden-tab-read", 1, [
      { from: "peer", body: "E2E hidden-tab read" },
      { from: "peer", body: "E2E hidden-tab unread" },
    ]);
    const cursor = async () =>
      (await db.conversationMember.findUniqueOrThrow({ where: { id: channel.viewer.id } }))
        .readThroughSequence;
    await mkdir(artifacts, { recursive: true });
    await Bun.write(hiddenFromStart, visibility("hidden"));

    await browser("--init-script", hiddenFromStart, "set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.channelId}`);
    await browser(
      "wait",
      "--fn",
      `Boolean(document.getElementById("message-${channel.ids[1]}")) && ${pageHydrated}`,
    );
    expect(await evaluate<string>("document.visibilityState")).toBe("hidden");
    // Loaded, with nobody looking: nothing is read.
    await Bun.sleep(2_000);
    await browser("screenshot", join(artifacts, "hidden.png"));
    expect(await cursor()).toBe(1);

    // The tab comes to the front.
    await evaluate(
      `(() => { ${visibility("visible")} document.dispatchEvent(new Event("visibilitychange")); return true; })()`,
    );
    await waitFor(async () => (await cursor()) === 2);
    await browser("screenshot", join(artifacts, "visible.png"));
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 90_000);

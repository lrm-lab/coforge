import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";
import { waitFor } from "./helpers/activity-inbox-e2e";
import { dividerBetween, inView, seedChannel } from "./helpers/open-unread-e2e";
import { sameOriginProxy } from "./helpers/same-origin-proxy";
import { serverFunctionIds, serverFunctionOf } from "./helpers/server-function-ids";

/**
 * A channel whose open read fails (task #378): the read of where the viewer's unread starts
 * (`loadConversationOpen`) answers 503. The pane shows its messages at the latest, draws no
 * "New messages" divider and leaves the read cursor alone. Once the read gets through (it is
 * retried), the divider is drawn on the first unread message and the cursor moves.
 *
 * Opt-in like the other browser E2Es: real local Web built with `bun run build` and served from
 * `.output/` (`COFORGE_E2E_WEB_URL`), `agent-browser` and local PostgreSQL. The browser talks to a
 * proxy in this test, which refuses the open read by the Server Function id that build gave it
 * (`serverFunctionIds`). A screenshot is written under `.amp/e2e/open-read-failed/`.
 */
const { origin: webOrigin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/open-read-failed");
const openReadIds = serverFunctionIds(["loadConversationOpen"]);

test("a failed open read leaves no divider and no read, until a retry gets through", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `open-read-failed-${process.pid}`);
  let refusing = true;
  let refused = 0;
  const proxy = sameOriginProxy(webOrigin, webOrigin, {
    refuse: (url) => {
      const refuse = refusing && serverFunctionOf(openReadIds, url) !== undefined;
      if (refuse) refused += 1;
      return refuse;
    },
  });
  try {
    const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    // Read through the third message of forty: the fourth is the first unread.
    const messages = Array.from({ length: 40 }, (_, index) => ({
      from: "peer" as const,
      body: `E2E open-read-failed ${index + 1}`,
    }));
    const channel = await seedChannel(db, workspaceId, "e2e-open-read-failed", 3, messages);
    const cursor = async () =>
      (
        await db.conversationMember.findUniqueOrThrow({
          where: { id: channel.viewer.id },
          select: { readThroughSequence: true },
        })
      ).readThroughSequence;
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${proxy.origin}/en/w/${workspace.slug}/channel/${channel.channelId}`);
    const last = channel.ids.at(-1)!;
    await browser("wait", "--fn", `${inView(last)} && ${pageHydrated}`);

    // Refused at least twice (the first try and a retry): still at the latest, no divider, no read.
    await waitFor(async () => refused >= 2);
    expect(
      await evaluate<boolean>(
        `document.querySelector('[role="separator"][aria-label="New messages"]') !== null`,
      ),
    ).toBe(false);
    expect(await evaluate<boolean>(inView(last))).toBe(true);
    expect(await cursor()).toBe(3);
    await browser("screenshot", join(artifacts, "refused.png"));

    // The next retry gets through: the divider goes above the first unread, and the read follows.
    refusing = false;
    // Retries double from 2s, so the one that gets through may be some seconds away.
    const dividedBy = Date.now() + 40_000;
    while (!(await evaluate<boolean>(dividerBetween(channel.ids[2]!, channel.ids[3]!)))) {
      if (Date.now() > dividedBy) throw new Error("no divider once the open read got through");
      await Bun.sleep(250);
    }
    await waitFor(async () => (await cursor()) === messages.length);
    await browser("screenshot", join(artifacts, "retried.png"));
  } finally {
    await browser("close").catch(() => undefined);
    proxy.stop();
    await db.$disconnect();
  }
}, 120_000);

import { test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";
import { inPane, waitFor } from "./helpers/activity-inbox-e2e";
import { dividerBetween, postLive, row, seedChannel } from "./helpers/open-unread-e2e";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/**
 * QA's path on staging (task #358), all within the page: a channel read in Chat, another channel
 * opened, messages come into the first, and Activity's Unread view opens it, with more arriving
 * as it opens. The pane lands on the first new message under the "New messages" divider, and
 * the divider stays there. Opt-in like the other browser E2Es: real local Web, Centrifugo
 * (`COFORGE_E2E_CENTRIFUGO_URL`, behind a same-origin proxy, so messages arrive live) and
 * `agent-browser`. A screenshot is written under `.amp/e2e/activity-open-unread/`.
 */
const { origin: webOrigin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin) throw new Error("COFORGE_E2E_CENTRIFUGO_URL is required");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/activity-open-unread");

test("a channel read in Chat and opened from Activity after messages came shows its divider", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser } = browserSession(browserPath, `activity-open-cached-${process.pid}`);
  const realtime = new CentrifugoConversationRealtime(createCentrifugoServerApi());
  const proxy = sameOriginProxy(webOrigin, centrifugoOrigin);
  const { origin } = proxy;
  try {
    const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    // Short enough that the window never evicts its live end, as on #teste-testa, so what comes
    // in while the channel is open reaches the pane.
    const read = Array.from({ length: 40 }, (_, index) => ({
      from: "peer" as const,
      body: `E2E open-cached read ${index + 1}`,
    }));
    const channel = await seedChannel(db, workspaceId, "e2e-open-cached", read.length, read);
    await seedChannel(db, workspaceId, "e2e-open-cached-elsewhere", 1, [
      { from: "peer", body: "E2E open-cached elsewhere" },
    ]);
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.channelId}`);
    await browser(
      "wait",
      "--fn",
      `Boolean(document.getElementById("message-${channel.ids.at(-1)!}")) && ${pageHydrated}`,
    );

    await browser("find", "text", "e2e-open-cached-elsewhere", "click");
    await browser(
      "wait",
      "--fn",
      `document.body.textContent.includes("E2E open-cached elsewhere")`,
    );
    const send = (sequence: number, body: string) =>
      postLive(db, realtime, { channelId: channel.channelId, workspaceId, sequence, body });
    const first = await send(read.length + 1, "E2E open-cached probe");
    // An Agent's receipt, as on staging's #teste-testa.
    await send(read.length + 2, "E2E open-cached probe received");

    await browser("find", "role", "link", "click", "--name", "Activity", "--exact");
    await browser(
      "wait",
      "--fn",
      `[...document.querySelectorAll('[role="tab"]')].some((tab) => tab.textContent.startsWith("Unread"))`,
    );
    await browser(
      "eval",
      `[...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent.startsWith("Unread")).click()`,
    );
    await browser("wait", "--fn", `${row("E2E open-cached probe received")} !== null`);
    await browser("find", "text", "E2E open-cached probe received", "click");
    // More comes in while the channel opens.
    await send(read.length + 3, "E2E open-cached during");
    await browser("wait", "--fn", inPane(first));
    await browser("wait", "--fn", dividerBetween(channel.ids.at(-1)!, first));
    // The pane reads what it shows; the divider stays over the first new message.
    await waitFor(
      async () =>
        (await db.conversationMember.findUniqueOrThrow({ where: { id: channel.viewer.id } }))
          .readThroughSequence >=
        read.length + 2,
    );
    await browser("screenshot", join(artifacts, "open-cached.png"));
    await browser("wait", "--fn", dividerBetween(channel.ids.at(-1)!, first));
  } finally {
    await browser("close").catch(() => undefined);
    proxy.stop();
    await db.$disconnect();
  }
}, 90_000);

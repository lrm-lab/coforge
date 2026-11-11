import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";
import { waitFor } from "./helpers/activity-inbox-e2e";
import { seedChannel } from "./helpers/open-unread-e2e";

/**
 * A channel that loads while nobody is looking reads nothing (task #549), as on Raft: a tab opened
 * behind the current one, a tab restored when the browser starts, or a window left behind another
 * one loads the channel's newest messages unseen, so they stay unread (and their sender does not
 * see them as seen) until the page is on screen with its window focused, which reads them then. A
 * message that arrives while a tab is hidden is not loaded until the tab is back
 * (`conversation-realtime-client.ts`), so loading is where an unseen read could start.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channel, its peer and
 * its messages are seeded deterministically and reset on every run. Screenshots are written under
 * `.amp/e2e/hidden-tab-read/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/hidden-tab-read");

/** What the page says about itself: on screen or not, and whether its window has focus. */
const pageState = (state: { visible: boolean; focused: boolean }) => `
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => ${JSON.stringify(state.visible ? "visible" : "hidden")} });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => ${!state.visible} });
  document.hasFocus = () => ${state.focused};
`;

for (const away of [
  { name: "a background tab", file: "hidden", state: { visible: false, focused: false } },
  { name: "a window without focus", file: "unfocused", state: { visible: true, focused: false } },
] as const)
  test(`a channel opened in ${away.name} is read only once someone is looking`, async () => {
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    const { browser, evaluate } = browserSession(
      browserPath,
      `hidden-tab-read-${away.file}-${process.pid}`,
    );
    // The page is in that state from its first script on, before the app reads anything.
    const fromStart = join(artifacts, `${away.file}-from-start.js`);
    try {
      const { workspaceId, workspace } = await devBrowserWorkspace(db);
      // Read through the first message; the second arrived since.
      const channel = await seedChannel(db, workspaceId, `e2e-unseen-read-${away.file}`, 1, [
        { from: "peer", body: "E2E unseen read" },
        { from: "peer", body: "E2E unseen unread" },
      ]);
      const cursor = async () =>
        (await db.conversationMember.findUniqueOrThrow({ where: { id: channel.viewer.id } }))
          .readThroughSequence;
      await mkdir(artifacts, { recursive: true });
      await Bun.write(fromStart, pageState(away.state));

      await browser("--init-script", fromStart, "set", "viewport", "1440", "900");
      await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.channelId}`);
      await browser(
        "wait",
        "--fn",
        `Boolean(document.getElementById("message-${channel.ids[1]}")) && ${pageHydrated}`,
      );
      expect(await evaluate<boolean>("document.hasFocus()")).toBe(false);
      // Loaded, with nobody looking: nothing is read.
      await Bun.sleep(2_000);
      await browser("screenshot", join(artifacts, `${away.file}.png`));
      expect(await cursor()).toBe(1);

      // The window comes to the front with focus.
      await evaluate(
        `(() => { ${pageState({ visible: true, focused: true })} document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); return true; })()`,
      );
      await waitFor(async () => (await cursor()) === 2);
      await browser("screenshot", join(artifacts, `${away.file}-back.png`));
    } finally {
      await browser("close").catch(() => undefined);
      await db.$disconnect();
    }
  }, 90_000);

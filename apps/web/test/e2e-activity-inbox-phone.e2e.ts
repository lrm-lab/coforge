import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";
import {
  inPane,
  listHidden,
  openParam,
  pane,
  rowItems,
  seedChannel,
  shownInPane,
} from "./helpers/activity-inbox-e2e";

/**
 * The Activity page on a phone, in a real browser: the tabs under the title; a row opening its
 * conversation full-screen in place of the list, a step in history that the header's back arrow
 * (past a thread opened in the conversation, and after a reload) and the back gesture return
 * from; a thread's row
 * opening its thread alone; and a link naming a conversation opening it full-screen, its back
 * arrow returning to the list.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channel, its peer and
 * its messages are seeded deterministically and reset on every run. Screenshots of the list
 * (`phone.png`) and of a conversation open (`phone-open.png`) are written under
 * `.amp/e2e/activity-inbox/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/activity-inbox");

test("on a phone a row opens its conversation in place of the Activity list", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `activity-inbox-phone-${process.pid}`;
  const { browser, evaluate } = browserSession(browserPath, session);
  /** The text of this test's rows (its channel's and its thread's), in page order. */
  const seededRows = `[...document.querySelectorAll(${rowItems})].map((row) => row.textContent).filter((text) => text.includes("e2e-activity-phone"))`;
  try {
    const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    const workspacePath = `/en/w/${workspace.slug}`;
    const { channelId, rootId, replyId, newestId } = await seedChannel(db, {
      workspaceId,
      key: "e2e-activity-inbox:phone-",
      channelName: "e2e-activity-phone",
      root: "E2E phone root",
      reply: `<@human:${DEV_BROWSER_USER.id}> E2E phone reply`,
      newest: { key: "unread", body: "E2E phone unread" },
      mention: "reply",
    });
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}${workspacePath}/activity`);
    await browser("wait", "--fn", `${seededRows}.length === 2 && ${pageHydrated}`);
    // On a phone the tabs take their own row under the title.
    expect(
      await evaluate<boolean>(
        `document.querySelector('[role="tablist"]').getBoundingClientRect().top >= document.querySelector("h1").getBoundingClientRect().bottom`,
      ),
    ).toBe(true);
    await browser("screenshot", join(artifacts, "phone.png"));
    // A row opens its conversation in place of the list, still on Activity. Opening it is a step
    // in history: the header's back arrow returns to the list by going back to it (past a thread
    // opened and closed in the conversation), and so does the phone's back gesture.
    const listEntry = await evaluate<number>("navigation.currentEntry.index");
    const listAlone = `${openParam} === null && ${pane} === null && ${listHidden} === false`;
    await browser("find", "text", "E2E phone unread", "click");
    await browser(
      "wait",
      "--fn",
      `${openParam} === ${JSON.stringify(`channel:${channelId}`)} && ${shownInPane(newestId)} && ${listHidden} === true`,
    );
    expect(await evaluate<string>("location.pathname")).toBe(`${workspacePath}/activity`);
    expect(await evaluate<number>("navigation.currentEntry.index")).toBe(listEntry + 1);
    // The thread summary's name runs on into the reply's preview.
    await evaluate(`[...${pane}.querySelectorAll("button")]
      .find((button) => button.textContent.trim().startsWith("1 reply"))
      .click() ?? true`);
    await browser("wait", "--fn", `location.search.includes("threadRootId=${rootId}")`);
    await browser("wait", "--fn", shownInPane(replyId));
    expect(await evaluate<number>("navigation.currentEntry.index")).toBe(listEntry + 2);
    await browser("find", "role", "button", "click", "--name", "Back to chat");
    await browser("wait", "--fn", `!location.search.includes("threadRootId")`);
    await browser("find", "role", "button", "click", "--name", "Back to Activity");
    await browser("wait", "--fn", listAlone);
    expect(await evaluate<number>("navigation.currentEntry.index")).toBe(listEntry);
    // A reload keeps that way back: the arrow still returns to the list's entry.
    await browser("find", "text", "E2E phone unread", "click");
    await browser("wait", "--fn", `${shownInPane(newestId)} && ${listHidden} === true`);
    await browser("reload");
    await browser("wait", "--fn", `${shownInPane(newestId)} && ${pageHydrated}`);
    await browser("find", "role", "button", "click", "--name", "Back to Activity");
    await browser("wait", "--fn", listAlone);
    expect(await evaluate<number>("navigation.currentEntry.index")).toBe(listEntry);
    // A thread's row opens the thread alone.
    await browser("find", "text", "E2E phone root", "click");
    await browser(
      "wait",
      "--fn",
      `${openParam} === ${JSON.stringify(`thread:channel:${channelId}`)} && ${shownInPane(replyId)} && ${listHidden} === true`,
    );
    expect(await evaluate<boolean>(shownInPane(newestId))).toBe(false);
    await browser("back");
    await browser("wait", "--fn", listAlone);

    // A link that names a conversation (a reload, a shared link) opens it full-screen on a phone,
    // at its message, with the list hidden; the header's back arrow returns to the list.
    await browser(
      "open",
      `${origin}${workspacePath}/activity?open=channel:${channelId}&msg=${rootId}`,
    );
    await browser("wait", "--fn", `${inPane(rootId)} && ${pageHydrated}`);
    // The list is hidden, not removed: crossing `lg` does not remount it.
    await browser("wait", "--fn", `${listHidden} === true`);
    await browser("screenshot", join(artifacts, "phone-open.png"));
    await browser("find", "role", "button", "click", "--name", "Back to Activity");
    await browser(
      "wait",
      "--fn",
      `location.pathname === ${JSON.stringify(`${workspacePath}/activity`)} && location.search === "" && ${listAlone} && ${seededRows}.length === 2`,
    );
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 90_000);

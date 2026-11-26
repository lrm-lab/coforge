import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import {
  animationsSettled,
  browserSession,
  devBrowserWorkspace,
  elementAtRest,
  hydratedElement,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";
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
 * (past a thread opened in the conversation, after a reload, after leaving the page and coming
 * back with Back, and without the Navigation API) and the back gesture return from; a thread's
 * row opening its thread alone; a link naming a conversation opening it full-screen, its back
 * arrow returning to the list; and the bottom tab bar (task #77), hidden on those inner pages,
 * leading between the four tab homes, and absent on a desktop.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channel, its peer and
 * its messages are seeded deterministically and reset on every run. Screenshots of the list
 * (`phone.png`) and of a conversation open (`phone-open.png`) are written under
 * `.artifacts/e2e/activity-inbox/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/activity-inbox");

const tabBar = `document.querySelector('nav[aria-label="Primary navigation"]')`;
/** The tab the bar marks current, by its visible label. */
const currentTab = `${tabBar}?.querySelector('a[aria-current="page"] span.truncate')?.textContent ?? null`;
const filterTabs = `document.querySelectorAll('[data-activity-list] [role="tablist"] [role="tab"]')`;
const pageLoadError = `(() => { const text = document.body.innerText; return text.includes("Couldn't load this page") || text.includes("无法加载此页面"); })()`;

test("on a phone a row opens its conversation in place of the Activity list", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `activity-inbox-phone-${process.pid}`;
  const { browser, evaluate } = browserSession(browserPath, session);
  /** The text of this test's rows (its channel's and its thread's), in page order. */
  const seededRows = `[...document.querySelectorAll(${rowItems})].map((row) => row.textContent).filter((text) => text.includes("e2e-activity-phone"))`;
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const workspacePath = `/en/w/${workspace.slug}`;
  const tail = `${process.pid}-${Date.now()}`;
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `tabbar-${tail}`,
      displayName: `Tab bar agent ${tail}`,
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
    },
  });
  // On phone viewports /w/:slug keeps ConversationPending's infinite animate-pulse mounted
  // behind the mobile sidebar, so only finite DocumentTimeline transitions should block here.
  const settled = () => browser("wait", "--fn", animationsSettled({ allowInfinite: true }));
  const clickBack = async (name: string) => {
    const selector = `button[aria-label=${JSON.stringify(name)}]`;
    await browser(
      "wait",
      "--fn",
      `${elementAtRest(`document.querySelector(${JSON.stringify(selector)})`)} && (() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b) return false; const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.width > 0 && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("button") === b; })()`,
    );
    await browser("find", "role", "button", "click", "--name", name);
  };
  /** Presses a tab by its label and waits for its page with it marked current. */
  const pressTab = async (label: string, path: string) => {
    await settled();
    await browser(
      "eval",
      `[...${tabBar}.querySelectorAll("a")].find((a) => a.querySelector("span.truncate")?.textContent === ${JSON.stringify(label)}).click()`,
    );
    await browser(
      "wait",
      "--fn",
      `location.pathname.endsWith(${JSON.stringify(path)}) && (${currentTab}) === ${JSON.stringify(label)}`,
    );
  };
  try {
    const internalProjectsHref = `/w/${workspace.slug}/projects`;
    const { channelId, rootId, replyId, newestId } = await seedChannel(db, {
      workspaceId,
      key: "e2e-activity-inbox:phone-",
      channelName: "e2e-activity-phone",
      root: "E2E phone root",
      reply: `<@human:${DEV_BROWSER_USER.id}> E2E phone reply`,
      newest: { key: "unread", body: `E2E phone unread\n\n[Projects](${internalProjectsHref})` },
      mention: "reply",
    });
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}${workspacePath}/activity`);
    // Wait for `useBreakpoint("lg")` to hydrate from its desktop SSR default into phone layout.
    await browser(
      "wait",
      "--fn",
      `${seededRows}.length === 2 && ${pageHydrated} && document.querySelector('[role="tablist"]') !== null`,
    );
    // On a phone the tabs take their own row under the title.
    expect(
      await evaluate<boolean>(
        `document.querySelector('[role="tablist"]').getBoundingClientRect().top >= document.querySelector("h1").getBoundingClientRect().bottom`,
      ),
    ).toBe(true);
    await settled();
    expect(await evaluate<boolean>(pageLoadError)).toBe(false);
    expect(await evaluate<number>(`${filterTabs}.length`)).toBe(5);
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
    await clickBack("Back to chat");
    await browser("wait", "--fn", `!location.search.includes("threadRootId")`);
    await clickBack("Back to activity");
    await browser("wait", "--fn", listAlone);
    expect(await evaluate<number>("navigation.currentEntry.index")).toBe(listEntry);
    // A reload keeps that way back: the arrow still returns to the list's entry.
    await browser("find", "text", "E2E phone unread", "click");
    await browser("wait", "--fn", `${shownInPane(newestId)} && ${listHidden} === true`);
    await browser("reload");
    await browser("wait", "--fn", `${shownInPane(newestId)} && ${pageHydrated}`);
    await clickBack("Back to activity");
    await browser("wait", "--fn", listAlone);
    expect(await evaluate<number>("navigation.currentEntry.index")).toBe(listEntry);
    // So does leaving for another page in the app and coming back with Back: the arrow returns to
    // the list's entry rather than stacking a copy of the list.
    await browser("find", "text", "E2E phone unread", "click");
    await browser("wait", "--fn", `${shownInPane(newestId)} && ${listHidden} === true`);
    const tasksPath = JSON.stringify(`${workspacePath}/projects`);
    const projectsLinkSelector = `section[aria-label="Selected conversation"] [id="message-${newestId}"] a[href=${JSON.stringify(internalProjectsHref)}]`;
    await browser(
      "wait",
      "--fn",
      elementAtRest(`document.querySelector(${JSON.stringify(projectsLinkSelector)})`),
    );
    const spaTimeOrigin = await evaluate<number>("performance.timeOrigin");
    await browser("click", projectsLinkSelector);
    await browser("wait", "--fn", `location.pathname === ${tasksPath}`);
    expect(await evaluate<number>("performance.timeOrigin")).toBe(spaTimeOrigin);
    await browser("back");
    await browser("wait", "--fn", `${shownInPane(newestId)} && ${listHidden} === true`);
    expect(await evaluate<number>("performance.timeOrigin")).toBe(spaTimeOrigin);
    await clickBack("Back to activity");
    await browser("wait", "--fn", listAlone);
    expect(await evaluate<number>("navigation.currentEntry.index")).toBe(listEntry);
    // Without the Navigation API (before Safari 26.2 and Firefox 147) the arrow still returns to
    // the list's entry it was opened over, within the visit, past a thread opened meanwhile.
    await evaluate(`(window.navigation = undefined, true)`);
    const listIndex = await evaluate<number>("history.state.__TSR_index");
    await browser("find", "text", "E2E phone unread", "click");
    await browser("wait", "--fn", `${shownInPane(newestId)} && ${listHidden} === true`);
    await evaluate(`[...${pane}.querySelectorAll("button")]
      .find((button) => button.textContent.trim().startsWith("1 reply"))
      .click() ?? true`);
    await browser("wait", "--fn", `location.search.includes("threadRootId=${rootId}")`);
    await browser("wait", "--fn", shownInPane(replyId));
    await clickBack("Back to chat");
    await browser("wait", "--fn", `!location.search.includes("threadRootId")`);
    await clickBack("Back to activity");
    await browser("wait", "--fn", listAlone);
    expect(await evaluate<number>("history.state.__TSR_index")).toBe(listIndex);
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
    // An open conversation fills the screen without the tab bar.
    expect(await evaluate<boolean>(`${tabBar} === null`)).toBe(true);
    await browser("screenshot", join(artifacts, "phone-open.png"));
    await clickBack("Back to activity");
    await browser(
      "wait",
      "--fn",
      `location.pathname === ${JSON.stringify(`${workspacePath}/activity`)} && location.search === "" && ${listAlone} && ${seededRows}.length === 2`,
    );

    // The phone's bottom tab bar (task #77): the open conversation above hid it, and the list
    // brings it back with Activity marked current, a render after the list itself, so the check
    // waits for it. Chats, Activity, Workspace and Me lead to each other, the current one marked.
    await browser("wait", "--fn", `(${currentTab}) === "Activity"`);
    await pressTab("Chats", workspacePath);
    await pressTab("Activity", "/activity");
    await pressTab("Workspace", "/workspace");
    await pressTab("Me", "/me");
    await pressTab("Chats", workspacePath);
    // An Agent's page from a link (its profile over Members) has no bar; closing it leaves
    // Members, whose back arrow goes to the Workspace tab, Members' place.
    const visibleBack = `[...document.querySelectorAll('button[aria-label="Back"]')].find((b) => b.checkVisibility())`;
    await browser("open", `${origin}${workspacePath}/agent/${agent.id}`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.body.textContent.includes(${JSON.stringify(agent.displayName)}) && document.querySelector('button[aria-label="Close"]') != null`,
    );
    expect(await evaluate<boolean>(`${tabBar} === null`)).toBe(true);
    await settled();
    await browser("click", `button[aria-label="Close"]`);
    await browser(
      "wait",
      "--fn",
      `!location.search.includes("profile=") && ${visibleBack} != null`,
    );
    expect(await evaluate<boolean>(`${tabBar} === null`)).toBe(true);
    await settled();
    await browser("eval", `${visibleBack}.click()`);
    await browser(
      "wait",
      "--fn",
      `location.pathname.endsWith("/workspace") && (${currentTab}) === "Workspace"`,
    );
    // A desktop has the sidebar and no tab bar.
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}${workspacePath}`);
    await browser("wait", "--fn", pageHydrated);
    await settled();
    expect(await evaluate<boolean>(`${tabBar} === null`)).toBe(true);
    await browser("set", "viewport", "1920", "898");
    await browser("open", `${origin}${workspacePath}/activity`);
    await browser(
      "wait",
      "--fn",
      `${seededRows}.length === 2 && ${pageHydrated} && document.querySelector('[data-activity-list]') !== null`,
    );
    expect(await evaluate<boolean>(pageLoadError)).toBe(false);
    await browser("set", "viewport", "390", "844");
    await browser("wait", "--fn", `${seededRows}.length === 2 && ${filterTabs}.length === 5`);
    await settled();
    expect(await evaluate<boolean>(pageLoadError)).toBe(false);
    const unreadTab = `[...${filterTabs}].find((tab) => tab.textContent?.trim().startsWith("Unread"))`;
    await browser("wait", "--fn", `${unreadTab} !== undefined && ${hydratedElement(unreadTab)}`);
    await evaluate(`${unreadTab}.click() ?? true`);
    await browser(
      "wait",
      "--fn",
      `location.search.includes("filter=unread") && (${unreadTab})?.getAttribute("aria-selected") === "true" && ${seededRows}.length >= 1`,
    );
    expect(await evaluate<boolean>(pageLoadError)).toBe(false);
  } finally {
    await browser("close").catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 150_000);

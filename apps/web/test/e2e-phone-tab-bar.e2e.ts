import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";
import { seedChannel } from "./helpers/activity-inbox-e2e";

/**
 * The phone's bottom tab bar (task #77), 390 wide: Chats, Activity, Workspace and Me lead to each
 * other, the current one marked; an Activity item opened full screen hides the bar and its back
 * arrow brings the list and the bar back; an Agent's page opened from a link, once closed, goes
 * back to the Workspace tab; a desktop has no tab bar. Screenshots, light and dark, of each tab home are
 * written under `.amp/e2e/phone-tab-bar/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/phone-tab-bar");

const tabBar = `document.querySelector('nav[aria-label="Primary navigation"]')`;
/** The tab the bar marks current, by its visible label. */
const currentTab = `${tabBar}?.querySelector('a[aria-current="page"] span.truncate')?.textContent ?? null`;

test("a phone's tab bar leads between the four tab homes and hides on inner pages", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `phone-tab-bar-${process.pid}`);
  const tail = `${process.pid}-${Date.now()}`;
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const base = `${origin}/en/w/${workspace.slug}`;
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
  const settled = () =>
    browser("wait", "--fn", `document.getAnimations().every((a) => a.playState !== "running")`);
  const shots = async (name: string) => {
    await settled();
    await browser("screenshot", join(artifacts, `${name}.png`));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await settled();
    await browser("screenshot", join(artifacts, `${name}-dark.png`));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
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
    const { channelId, rootId } = await seedChannel(db, {
      workspaceId,
      key: "e2e-phone-tab-bar:",
      channelName: "e2e-phone-tab-bar",
      root: "E2E tab bar root",
      reply: `<@human:${DEV_BROWSER_USER.id}> E2E tab bar reply`,
      newest: { key: "unread", body: "E2E tab bar unread" },
      mention: "reply",
    });
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "390", "844");

    // Chats is the Workspace's home, and each tab leads to the next, marked current.
    await browser("open", base);
    await browser("wait", "--fn", `${pageHydrated} && (${currentTab}) === "Chats"`);
    await shots("chats");
    await pressTab("Activity", "/activity");
    await shots("activity");
    await pressTab("Workspace", "/workspace");
    await shots("workspace");
    await pressTab("Me", "/me");
    await shots("me");
    await pressTab("Chats", `/w/${workspace.slug}`);

    // An Activity item fills the screen without the bar; its back arrow returns to the list and
    // the bar.
    await browser("open", `${base}/activity?open=channel:${channelId}&msg=${rootId}`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.querySelector('button[aria-label="Back to activity"]') != null`,
    );
    expect(await evaluate<boolean>(`${tabBar} === null`)).toBe(true);
    await settled();
    await browser("click", `button[aria-label="Back to activity"]`);
    await browser(
      "wait",
      "--fn",
      `!location.search.includes("open=") && (${currentTab}) === "Activity"`,
    );

    // An Agent's page from a link (its profile over Members) has no bar; closing it leaves
    // Members, whose back arrow goes to the Workspace tab, Members' place.
    const visibleBack = `[...document.querySelectorAll('button[aria-label="Back"]')].find((b) => b.checkVisibility())`;
    await browser("open", `${base}/agent/${agent.id}`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.body.textContent.includes(${JSON.stringify(`Tab bar agent ${tail}`)}) && document.querySelector('button[aria-label="Close"]') != null`,
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
    await browser("open", base);
    await browser("wait", "--fn", pageHydrated);
    await settled();
    expect(await evaluate<boolean>(`${tabBar} === null`)).toBe(true);
  } catch (failure) {
    await browser("screenshot", join(artifacts, "failure.png")).catch(() => undefined);
    throw failure;
  } finally {
    await browser("close").catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);

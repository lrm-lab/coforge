import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import {
  browserSession,
  hydratedElement,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";

/**
 * The Workspace's AI Workbench experiment on Settings → Experiments (tasks #743, #43): on by default
 * (Frank 11-09), switched by the Workspace's owner or admin, the sidebar entry following it without
 * a reload, `/pi-chat` going home while it is off, and a second browser session following when it
 * regains focus.
 *
 * Opt-in like the other browser e2e files: real local Web, `agent-browser` and PostgreSQL. The
 * Experiments row is photographed on and off in both languages under /tmp/hp/743/.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const screenshots = "/tmp/hp/743";

test("the AI Workbench switch controls the sidebar entry and the route, across sessions", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const first = browserSession(browserPath, `workbench-a-${process.pid}`);
  const second = browserSession(browserPath, `workbench-b-${process.pid}`);
  const { workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    orderBy: { createdAt: "asc" },
    include: { workspace: { select: { slug: true } } },
  });
  const before = (
    await db.workspace.findUniqueOrThrow({
      where: { slug: workspace.slug },
      select: { experiments: true },
    })
  ).experiments;
  const stored = async () =>
    (
      (
        await db.workspace.findUniqueOrThrow({
          where: { slug: workspace.slug },
          select: { experiments: true },
        })
      ).experiments as Record<string, boolean> | null
    )?.aiWorkbench;
  /** Back to never stored: the key is removed, the Workspace's other experiments stay. */
  const clear = async () => {
    const current = ((
      await db.workspace.findUniqueOrThrow({
        where: { slug: workspace.slug },
        select: { experiments: true },
      })
    ).experiments ?? {}) as Record<string, boolean>;
    const { aiWorkbench: _removed, ...rest } = current;
    await db.workspace.update({ where: { slug: workspace.slug }, data: { experiments: rest } });
  };
  const entry = `document.querySelectorAll('a[href*="/pi-chat"]').length > 0`;
  const switchInput = `document.querySelector('input[aria-label="AI Workbench"]')`;
  const home = (locale: string) => `${origin}/${locale}/w/${workspace.slug}`;
  const experiments = (locale: string) => `${home(locale)}/settings?section=experiments`;
  const toggle = async (session: typeof first, on: boolean) => {
    await session.waitFor(`${pageHydrated} && ${hydratedElement(switchInput)}`);
    // A real click: the switch listens for pointer presses, which a scripted click does not send.
    await session.browser(
      "eval",
      `(() => { ${switchInput}.closest("label").setAttribute("data-press", ""); return true; })()`,
    );
    await session.browser("click", "[data-press]");
    await session.browser(
      "eval",
      `(() => { document.querySelector("[data-press]")?.removeAttribute("data-press"); return true; })()`,
    );
    await session.waitFor(`${switchInput}.checked === ${on}`);
  };
  const shot = async (session: typeof first, name: string) => {
    await session.browser("wait", "400");
    await session.browser("screenshot", `${screenshots}/${name}.png`);
  };
  /** A window regaining focus: what a tab or device that did not make the change reads on. */
  const refocus = (session: typeof first) =>
    session.browser(
      "eval",
      `(document.dispatchEvent(new Event("visibilitychange", { bubbles: true })), true)`,
    );
  try {
    await mkdir(screenshots, { recursive: true });
    await clear();
    await first.browser("set", "viewport", "1280", "860");
    await second.browser("set", "viewport", "1280", "860");

    // Default on: a Workspace that never chose has the switch on and the sidebar entry.
    await first.browser("open", experiments("en"));
    await first.waitFor(`${pageHydrated} && ${switchInput} != null`, 60_000);
    expect(await first.evaluate<boolean>(`${switchInput}.checked`)).toBe(true);
    expect(await first.evaluate<boolean>(entry)).toBe(true);
    await shot(first, "experiments-en-default-on");
    await first.browser("open", experiments("zh-CN"));
    await first.waitFor(`${pageHydrated} && ${switchInput} != null`, 60_000);
    await shot(first, "experiments-zh-CN-default-on");

    // A second session of the same account, on the Workbench page.
    await second.browser("open", `${home("en")}/pi-chat`);
    await second.waitFor(`${pageHydrated} && ${entry}`, 60_000);

    // The owner turns it off in the Workspace's list: the entry hides at once, in the same page
    // load (the marker survives only without a reload), and false is stored for the Workspace.
    await first.browser("eval", `(window.__noReload = true)`);
    await toggle(first, false);
    await first.waitFor(`!(${entry})`);
    expect(await first.evaluate<boolean>(`window.__noReload === true`)).toBe(true);
    expect(await stored()).toBe(false);
    await shot(first, "experiments-zh-CN-off");
    await first.browser("open", `${home("en")}/pi-chat`);
    await first.waitFor(`${pageHydrated} && !location.pathname.endsWith("/pi-chat")`, 60_000);
    expect(await first.evaluate<string>(`location.pathname`)).toBe(`/en/w/${workspace.slug}`);

    // The other session follows when it regains focus: its open Workbench page is replaced by one
    // line and a link to the switch.
    await refocus(second);
    await second.waitFor(`!(${entry})`);
    await second.waitFor(
      `document.querySelector('main [role="status"]')?.textContent.includes("AI Workbench is off")`,
    );
    expect(
      await second.evaluate<string>(
        `document.querySelector('main [role="status"] a').getAttribute("href")`,
      ),
    ).toContain("/settings?section=experiments");

    // Turning it back on restores the entry here and, on focus, in the other session.
    await second.browser("open", home("en"));
    await second.waitFor(`${pageHydrated} && !(${entry})`, 60_000);
    await first.browser("open", experiments("en"));
    await first.waitFor(`${pageHydrated} && ${switchInput} != null`, 60_000);
    await first.browser("eval", `(window.__noReload = true)`);
    await toggle(first, true);
    await first.waitFor(entry);
    expect(await first.evaluate<boolean>(`window.__noReload === true`)).toBe(true);
    expect(await stored()).toBe(true);
    await shot(first, "experiments-en-on");
    await refocus(second);
    await second.waitFor(entry);
    await second.browser("open", `${home("en")}/pi-chat`);
    await second.waitFor(`${pageHydrated} && location.pathname.endsWith("/pi-chat")`, 60_000);
  } finally {
    await first.browser("close").catch(() => {});
    await second.browser("close").catch(() => {});
    await db.workspace.update({
      where: { slug: workspace.slug },
      data: { experiments: before ?? Prisma.DbNull },
    });
    await db.$disconnect();
  }
}, 240_000);

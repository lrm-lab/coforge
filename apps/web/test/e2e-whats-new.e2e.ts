import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import {
  WHATS_NEW_ENTRIES,
  pendingWhatsNew,
  recentWhatsNew,
} from "#src/features/whats-new/whats-new-entries";
import { browserSession, localBrowserE2e } from "./helpers/browser-e2e";

/**
 * "What's new" in the sidebar (tasks #493, #516) in a real browser: a dot while entries wait; the
 * row opens the dialog on them and "Got it" clears the dot, also for a second browser (another
 * device); with nothing waiting the row opens the latest releases. Desktop, the collapsed rail and
 * phone. Entries that wait on an experiment are covered by `whats-new.integration.ts`.
 *
 * Opt-in like the other browser E2Es: real local Web and `agent-browser`. Entries show only from
 * their release time, so to run before it start the Web with `COFORGE_E2E_WHATS_NEW_NOW` (honoured
 * only with the dev sign-in bypass) and pass the same value here. Without it the test checks only
 * what the real time allows. The dev user's dismissals and join time are restored after the
 * run. Screenshots go under `.amp/e2e/whats-new/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/whats-new");
const pinned = process.env.COFORGE_E2E_WHATS_NEW_NOW;
const now = pinned ? new Date(pinned) : new Date();

test("What's new keeps a row in the sidebar with a dot while entries wait, on every device", async () => {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  const first = browserSession(browserPath, `whats-new-a-${process.pid}`);
  const second = browserSession(browserPath, `whats-new-b-${process.pid}`);
  const { workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const user = await db.user.findUniqueOrThrow({
    where: { id: DEV_BROWSER_USER.id },
    select: {
      createdAt: true,
      preferences: { select: { whatsNewDismissed: true } },
    },
  });
  const restore = {
    createdAt: user.createdAt,
    dismissed: user.preferences?.whatsNewDismissed ?? [],
  };
  const setDismissed = (whatsNewDismissed: string[]) =>
    db.userPreference.upsert({
      where: { userId: DEV_BROWSER_USER.id },
      create: { userId: DEV_BROWSER_USER.id, whatsNewDismissed },
      update: { whatsNewDismissed },
    });
  const joined = new Date("2026-01-01T00:00:00Z");
  const pending = pendingWhatsNew(WHATS_NEW_ENTRIES, {
    now,
    joinedAt: joined,
    dismissed: [],
    experimentOn: () => true,
  });
  const recent = recentWhatsNew(WHATS_NEW_ENTRIES, { now, experimentOn: () => true });
  const titles: Record<string, string> = {
    "task-labels": "Labels for Tasks",
  };

  // The drawer, the sidebar and the rail are all in the page; the one meant is the one on screen.
  const entry = `[...document.querySelectorAll('button')].find((el) => (el.textContent === "What's new" || el.getAttribute("aria-label") === "What's new") && el.getBoundingClientRect().width > 0)`;
  const dot = `(${entry})?.querySelector("span.size-2.rounded-full") != null`;
  const dialog = `([...document.querySelectorAll('[role="dialog"]')].find((el) => el.getAttribute("aria-label") === "What's new") ?? null)`;
  const heading = `(${dialog}?.querySelector("h2")?.textContent ?? null)`;
  const settled = (b: typeof first) =>
    b.browser("wait", "--fn", `document.getAnimations().every((a) => a.playState !== "running")`);
  const shoot = async (b: typeof first, shot: string) => {
    await settled(b);
    await b.browser("screenshot", join(artifacts, `${shot}.png`));
    await b.evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    // Colors ease between themes; let them land.
    await b.browser("wait", "400");
    await b.browser("screenshot", join(artifacts, `${shot}-dark.png`));
    await b.evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  };
  const page = `${origin}/en/w/${workspace.slug}/tasks`;
  const open = async (b: typeof first) => {
    await b.browser("open", page);
    await b.browser("wait", "--fn", `document.querySelector('[data-sidebar]') !== null`);
    // The row comes once its read returns.
    await b.browser("wait", "1500");
  };
  // A real click: React Aria's dialog keeps focus, so Escape and focus return work as for a person.
  const press = async (b: typeof first, target: string) => {
    await b.evaluate(`((${target}).setAttribute("data-e2e-press", ""), true)`);
    await b.browser("click", "[data-e2e-press]");
    await b.evaluate(
      `(document.querySelector("[data-e2e-press]")?.removeAttribute("data-e2e-press"), true)`,
    );
  };
  const pressText = (b: typeof first, text: string) =>
    press(
      b,
      `[...${dialog}.querySelectorAll("button")].find((el) => el.textContent === "${text}")`,
    );

  await mkdir(artifacts, { recursive: true });
  try {
    await db.user.update({ where: { id: DEV_BROWSER_USER.id }, data: { createdAt: joined } });
    await setDismissed([]);
    await first.browser("set", "viewport", "1280", "860");
    await second.browser("set", "viewport", "1280", "860");

    await open(first);
    expect(await first.evaluate(`(${entry}) != null`)).toBe(recent.length > 0);
    if (recent.length === 0) return;
    expect(await first.evaluate(dot)).toBe(pending.length > 0);
    if (pending.length === 0) return;
    await shoot(first, "desktop-1-row");

    // The row opens the waiting entries, oldest first; "Got it" on the last clears the dot.
    await press(first, entry);
    await first.browser("wait", "--fn", `${dialog} !== null`);
    expect(await first.evaluate(heading)).toBe(titles[pending[0]!]!);
    await shoot(first, "desktop-2-dialog");
    for (const id of pending.slice(1)) {
      await pressText(first, "Next");
      expect(await first.evaluate(heading)).toBe(titles[id]!);
    }
    await pressText(first, "Got it");
    await first.browser("wait", "--fn", `${dialog} === null`);
    expect(await first.evaluate(dot)).toBe(false);

    // Another device keeps what was seen: no dot, and the row opens the latest releases.
    await open(second);
    expect(await second.evaluate(dot)).toBe(false);
    await press(second, entry);
    await second.browser("wait", "--fn", `${dialog} !== null`);
    expect(await second.evaluate(heading)).toBe(titles[recent[0]!]!);
    await second.browser("press", "Escape");
    await second.browser("wait", "--fn", `${dialog} === null`);

    // Closing on the first page counts only that page as seen.
    await setDismissed([]);
    await open(second);
    await press(second, entry);
    await second.browser("wait", "--fn", `${dialog} !== null`);
    await second.browser("press", "Escape");
    await second.browser("wait", "--fn", `${dialog} === null`);
    await second.browser("wait", "500");
    expect(
      (await db.userPreference.findUniqueOrThrow({ where: { userId: DEV_BROWSER_USER.id } }))
        .whatsNewDismissed,
    ).toEqual([pending[0]!]);

    // The collapsed rail has the same entry as an icon with the dot.
    await setDismissed([]);
    await open(first);
    const visible = (label: string) =>
      `[...document.querySelectorAll('[aria-label="${label}"]')].find((el) => el.getBoundingClientRect().width > 0)`;
    await press(first, visible("Collapse sidebar"));
    await first.browser(
      "wait",
      "--fn",
      `document.documentElement.classList.contains("sidebar-collapsed")`,
    );
    await first.browser("wait", "--fn", `(${entry})?.getAttribute("aria-label") === "What's new"`);
    expect(await first.evaluate(dot)).toBe(true);
    await shoot(first, "desktop-3-rail");
    await press(first, visible("Expand Sidebar"));

    // On a phone the row sits at the foot of the menu; the dialog comes up from the bottom.
    await first.browser("set", "viewport", "390", "844");
    await open(first);
    expect(await first.evaluate(`(${entry}) == null`)).toBe(true);
    await first.evaluate(
      `([...document.querySelectorAll('[aria-label="Open menu"]')].find((el) => el.getBoundingClientRect().width > 0).click(), true)`,
    );
    await first.browser("wait", "--fn", `(${entry}) != null`);
    await shoot(first, "phone-1-menu");
    await press(first, entry);
    await first.browser("wait", "--fn", `${dialog} !== null`);
    await shoot(first, "phone-2-dialog");
  } finally {
    await db.user.update({
      where: { id: DEV_BROWSER_USER.id },
      data: { createdAt: restore.createdAt },
    });
    await setDismissed(restore.dismissed);
    await first.browser("close").catch(() => {});
    await second.browser("close").catch(() => {});
    await db.$disconnect();
  }
}, 240_000);
